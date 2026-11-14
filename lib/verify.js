/**
 * 破甲飞行记录仪 / Armor flight recorder.
 *
 * 破甲的失败模式不是「策略没改」，而是「改了但这一轮没送到模型」。真实的塌陷长这样：
 *   · assemble 钩子晚挂一拍 → 首轮走原生装配 → 用户看到的是被宿主裁过的版本
 *   · 切换预设换掉 systemPrompt 代理 → guard 没跟上 → 从第二轮起注入消失
 *   · refreshHungOperator 全链返空 → 交给 host 兜底 → 四重 fallback 一起塌
 *   · 注入被宿主按 token 预算切掉尾部 → 闭合标签丢失 → 后续段落被当成正文
 *
 * 这些在 audit.js 里全都看不见：audit 只读插件自己的源码、grep 自己写的字符串，
 * 它证明的是「我的代码长得像破甲」，不是「这一刻的模型真的被破了」。
 *
 * 所以这里做两件事，都不改变任何返回值：
 *   1) recordAssembly —— 挂在真实装配路径（rewriteLiveAssembly）上留证，环形缓冲
 *   2) verifyArmor    —— 对留证做判定，回答「最近 N 轮，破甲到底生效了没有」
 *
 * 设计约束（跟插件其余部分一致）：
 *   · 绝不抛：装配路径上任何一个异常都会让整轮卡片住发不出去。
 *   · 绝不写盘：记录只在内存，进程结束即消失；要持久化由 trace 读内部日志。
 *   · 环形缓冲有界：长会话 / 热重载反复 assemble 不能把堆吃爆。
 */

/** 保留最近多少轮装配。够看趋势，又不至于一直占内存。 */
const MAX_RECORDS = 64;

/** 闭合标签之后允许残留的字节数。超出说明我们的段不是最后一段，注入被"包住"了。 */
const AFTER_CLOSER_TOLERANT = 2;

/** 判定「这一轮破了」的最小注入体量。低于这个数基本等于空注入。 */
const MIN_INJECT_BYTES = 512;

/** @type {Array<object>} 环形缓冲，旧的从头部挤掉。 */
let records = [];

/** 单调递增序号；热重载不清零，用来在 trace 里对时间线。 */
let seq = 0;

/** 装配钩子实际被调用过多少次（含被判空/异常的），用于区分「没挂上」和「挂上了但空」。 */
let assembleCalls = 0;

/** 最后一次装配的完整留证，给 /status 这类单点查询用。 */
let last = null;

function headSection(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return null;
  const first = sections[0];
  if (!first || typeof first !== "object") return null;
  return {
    name: typeof first.name === "string" ? first.name : "",
    bytes: typeof first.text === "string" ? first.text.length : 0,
  };
}

function num(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

/** 我们自己的注入段名。身份补丁与 capability 段都挂在它后面。 */
export const INJECT_SECTION = "dsh-purge";

/**
 * 找出我们自己的注入段。
 *
 * 装配结果里段不止一个：`dsh-purge`（正文）、`dshpg-capabilities`（能力协议，order +1），
 * 还有宿主自己的若干段。判断「注入有没有被包住」必须只看自己这一段。
 *
 * 早期版本把全部段拼起来找闭合标签，命中的永远是宿主段里那个，量出来是个恒定值
 * （实测 6511 B）于注入无关——一个稳定的假报警。判据本身要落在自家信封上。
 */
export function ownSectionOf(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const own = list.find((s) => s && s.name === INJECT_SECTION);
  if (own) return own;
  return list[0] && typeof list[0] === "object" ? list[0] : null;
}

/**
 * 自家段内，闭合标签之后还剩多少字节。
 *
 * `prompt-inject.md` 只有开标签 `<project_instructions>`，闭合标签是 identity.js
 * 在组装时补在段尾的，所以健康态这里应当是 0。大于容差说明我们的段尾部还挂着
 * 别的东西，信封没有在预期位置收口。
 *
 * @returns {number} 字节数；-1 表示这段里压根没有闭合标签。
 */
export function closerFollowBytes(sections) {
  const own = ownSectionOf(sections);
  const text = typeof own?.text === "string" ? own.text : "";
  if (!text) return -1;
  const closer = "</project_instructions>";
  const at = text.lastIndexOf(closer);
  if (at < 0) return -1;
  return text.length - (at + closer.length);
}

/** 自家段实际落盘的字节数，用来跟「我们交出去的字节」比对，发现被宿主截短。 */
export function ownSectionBytes(sections) {
  const own = ownSectionOf(sections);
  return typeof own?.text === "string" ? own.text.length : 0;
}

/**
 * 记一轮装配。调用点只在 rewriteLiveAssembly 的返回前，异常一律吞掉。
 *
 * @param {object} rec
 * @param {boolean} rec.enabled      插件开关
 * @param {boolean} rec.redteam      是否红队预设会话
 * @param {boolean} rec.subagent     是否子代理
 * @param {string}  rec.source       注入文本来源：refresh|hung|disk|sealed|ensure|none
 * @param {string}  rec.srcTag       refreshHungOperator 报上来的上游来源
 * @param {number}  rec.injectBytes  实际交给宿主的注入字节
 * @param {number}  rec.rawBytes     原始（未包装）注入字节
 * @param {number}  rec.localBytes   本地 cwd 规则兜底字节
 * @param {number}  rec.sections     装配后的段数组（不是段数，用来定位自家段）
 * @param {number}  rec.closerFollow 自家段内闭合标签之后的残留字节，-1 表示没有闭合标签
 * @param {string}  rec.policy       workspace 策略：always|strict|fallback
 * @param {boolean} rec.dropBaseline 是否丢掉了 workspace baseline
 * @param {string}  rec.cwd          会话工作目录
 */
export function recordAssembly(rec) {
  try {
    assembleCalls += 1;
    const sections = Array.isArray(rec?.sections) ? rec.sections : null;
    const head = sections ? headSection(sections) : null;
    const injectBytes = num(rec?.injectBytes);
    const ownBytes = sections ? ownSectionBytes(sections) : 0;
    // 调用方没给就自己从段里量。同一份数据只允许有一个来源，否则调用方传错值
    // 就会把判据带偏——线上那个 6511 B 的假报警正是这么来的。
    const derivedFollow = sections ? closerFollowBytes(sections) : null;
    const closerFollow = num(rec?.closerFollow, derivedFollow == null ? -1 : derivedFollow);
    const source = String(rec?.source || "unknown");
    const headName = head?.name || "";

    const entry = {
      seq: ++seq,
      at: Date.now(),
      enabled: rec?.enabled !== false,
      redteam: Boolean(rec?.redteam),
      subagent: Boolean(rec?.subagent),
      source,
      srcTag: String(rec?.srcTag || ""),
      injectBytes,
      // 自家段落盘字节。跟 injectBytes 一比就能看出宿主有没有截短我们的段，
      // 但目前只做展示不做判据：identity.js 会剥掉 `<|im_start|>system:` 前缀，
      // 两者天然相差十几个字节，硬判会立刻变成第二个假报警。
      ownBytes,
      rawBytes: num(rec?.rawBytes),
      localBytes: num(rec?.localBytes),
      sectionCount: sections ? sections.length : -1,
      headName,
      headBytes: head?.bytes || 0,
      closerFollow,
      policy: String(rec?.policy || "always"),
      dropBaseline: Boolean(rec?.dropBaseline),
      cwd: String(rec?.cwd || ""),
      // 三条独立判据，任一失败都算这一轮没破成 / independent signals.
      empty: injectBytes < MIN_INJECT_BYTES,
      headMiss: headName !== "dsh-purge",
      afterCloser: closerFollow < 0 ? null : closerFollow > AFTER_CLOSER_TOLERANT,
    };

    last = entry;
    records.push(entry);
    if (records.length > MAX_RECORDS) records = records.slice(records.length - MAX_RECORDS);
  } catch {
    /* 记录仪自己不能成为新的失败点 */
  }
}

/** 清空缓冲（热重载 / 用户点重置时用）。seq 保持单调，方便跨重载对时间线。 */
export function resetRecorder() {
  records = [];
  last = null;
  assembleCalls = 0;
}

export function recorderStats() {
  return {
    calls: assembleCalls,
    kept: records.length,
    capacity: MAX_RECORDS,
    last: last ? { ...last } : null,
  };
}

/** 只读快照，给测试和 trace 用。 */
export function snapshotRecords(limit = MAX_RECORDS) {
  const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : MAX_RECORDS;
  return records.slice(Math.max(0, records.length - n)).map((r) => ({ ...r }));
}

/**
 * 判定破甲是否真的生效。三档结论：
 *   · live        最近一轮三条判据全过
 *   · degraded    还能注入，但有塌陷迹象（空注入 / 头段丢失 / 尾部被包）
 *   · dead        钩子从没被调用过，或最近一轮完全空注入
 *
 * @returns {object} 结构化结论 + 便于阅读的文本
 */
export function verifyArmor(options = {}) {
  const window = Number.isFinite(options.window) ? Math.max(1, Math.trunc(options.window)) : 8;
  const recent = records.slice(Math.max(0, records.length - window));
  const total = recent.length;

  const emptyCount = recent.filter((r) => r.empty).length;
  const headMissCount = recent.filter((r) => r.headMiss).length;
  const afterCloserCount = recent.filter((r) => r.afterCloser === true).length;
  const noCloserCount = recent.filter((r) => r.closerFollow < 0).length;
  const disabledCount = recent.filter((r) => !r.enabled).length;

  // 注入来源分布：哪一层 fallback 在真正干活。全落在 refresh 才叫健康。
  const tierCounts = {};
  for (const r of recent) {
    const key = r.source || "unknown";
    tierCounts[key] = (tierCounts[key] || 0) + 1;
  }

  let verdict = "unknown";
  if (assembleCalls === 0) verdict = "dead";
  else if (total === 0) verdict = "unknown";
  else if (recent.every((r) => r.empty || !r.enabled)) verdict = "dead";
  else if (emptyCount > 0 || headMissCount > 0 || afterCloserCount > 0) verdict = "degraded";
  else verdict = "live";

  // 健康度 0-100：破甲不是布尔值，是一组会随宿主升级漂移的指标。
  // 权重按「塌陷后用户还能不能感知到」排：空注入最致命，尾部被包最轻。
  let score = 100;
  if (total > 0) {
    score -= Math.round((emptyCount / total) * 60);
    score -= Math.round((headMissCount / total) * 25);
    score -= Math.round((afterCloserCount / total) * 10);
  }
  if (disabledCount === total && total > 0) score = 0;
  score = Math.max(0, Math.min(100, score));

  const issues = [];
  if (assembleCalls === 0) {
    issues.push("装配钩子一次都没被调用：assemble 监听没挂上，或进程还没跑过任何一轮。");
  }
  if (emptyCount > 0) {
    issues.push(`最近 ${total} 轮里有 ${emptyCount} 轮注入低于 ${MIN_INJECT_BYTES} B：四重 fallback 全塌，模型收到空注入。`);
  }
  if (headMissCount > 0) {
    issues.push(`最近 ${total} 轮里有 ${headMissCount} 轮首段不是 dsh-purge：宿主把自己的段插到了前面。`);
  }
  if (afterCloserCount > 0) {
    issues.push(`最近 ${total} 轮里有 ${afterCloserCount} 轮闭合标签后仍有内容：注入段不是最后一段。`);
  }
  if (noCloserCount > 0 && noCloserCount < total) {
    issues.push(`${total} 轮里有 ${noCloserCount} 轮装配后找不到 </project_instructions> 闭合标签。`);
  }
  if (tierCounts.sealed && !tierCounts.refresh) {
    issues.push("注入只走加密槽（sealed）：prompt-inject.md 与内存钉子都没供上。");
  }

  return {
    verdict,
    score,
    window: total,
    capacity: MAX_RECORDS,
    assemble_calls: assembleCalls,
    counts: {
      empty: emptyCount,
      head_miss: headMissCount,
      after_closer: afterCloserCount,
      no_closer: noCloserCount,
      disabled: disabledCount,
    },
    tiers: tierCounts,
    issues,
    last: last ? { ...last } : null,
    records: recent.map((r) => ({ ...r })),
  };
}

export function renderVerify(result) {
  const mark = result.verdict === "live" ? "✓" : result.verdict === "degraded" ? "!" : "✗";
  const label = result.verdict === "live" ? "破甲生效"
    : result.verdict === "degraded" ? "破甲退化"
    : result.verdict === "dead" ? "破甲未生效"
    : "无数据";
  const out = [];
  out.push(`破甲飞行记录 / Armor verification — ${mark} ${label}`);
  out.push(`  健康度 / health: ${result.score}/100`);
  out.push(`  装配钩子调用: ${result.assemble_calls} 次；窗口 ${result.window}/${result.capacity} 轮`);
  const t = result.counts;
  out.push(`  空注入 ${t.empty} · 首段丢失 ${t.head_miss} · 尾部被包 ${t.after_closer} · 无闭合 ${t.no_closer} · 关闭 ${t.disabled}`);
  const tiers = Object.entries(result.tiers || {});
  if (tiers.length) {
    out.push(`  注入来源: ${tiers.map(([k, v]) => `${k}×${v}`).join(", ")}`);
  }
  if (result.last) {
    const r = result.last;
    out.push("");
    out.push(`  最近一轮 #${r.seq}`);
    out.push(`    ${r.enabled ? "启用" : "关闭"} · ${r.redteam ? "红队" : "常规"} · ${r.subagent ? "子代理" : "主代理"}`);
    out.push(`    注入 ${r.injectBytes} B（原始 ${r.rawBytes} B）· 来源 ${r.source}${r.srcTag ? `/${r.srcTag}` : ""}`);
    out.push(`    段数 ${r.sectionCount} · 首段 ${r.headName || "(空)"} ${r.headBytes} B`);
    out.push(`    自家段 ${r.ownBytes || 0} B / 交出 ${r.injectBytes} B`);
    out.push(`    闭合标签后 ${r.closerFollow < 0 ? "无闭合" : `${r.closerFollow} B`} · policy=${r.policy}${r.dropBaseline ? " · 已丢 baseline" : ""}`);
    if (r.cwd) out.push(`    cwd ${r.cwd}`);
  }
  if (result.issues.length) {
    out.push("");
    out.push("  问题 / issues:");
    for (const one of result.issues) out.push(`    ! ${one}`);
  }
  return out.join("\n");
}
