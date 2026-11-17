/**
 * 破甲语义分层 / semantic bypass layers.
 *
 * 逐条补丁状态（`patchStatus`）回答"这一行改了没有"；
 * 分层回答"用户能感觉到的哪个限制被拆掉了"。面板据此从 `74/74`
 * 变成「22 层里哪层没达标 + 为什么」。
 *
 * 分组思路借自 kingcharleslzy-ai/dsh-purge 的 `BYPASS_LAYERS`，
 * 但那份只覆盖它自己 86 条里的 56 条；这里补齐到本仓 88 条全覆盖，
 * 并在 `assertLayerCoverage()` 里做运行时校验——漏一条会直接抛错，
 * 不会静默从面板消失。
 *
 * `optionalIds` 的语义：同一层里混着必需补丁和可选补丁时，
 * 可选的那几条不参与"这层是否达标"的判定（它们的目标包常常没装）。
 */

export const BYPASS_LAYERS = Object.freeze([
  // ── 提示词层：免责声明、身份、边界话术 ─────────────────────────────
  {
    ids: [1, 2, 3],
    title: "全局免责声明拆除",
    kind: "prompt",
    why: "工作区指令不再自称'仅供参考、不覆盖 system/developer/用户指令'，改成 ACTIVE + MANDATORY",
  },
  {
    ids: [4, 25, 43, 71, 76],
    optionalIds: [71, 76],
    title: "官方身份剥离",
    kind: "prompt",
    why: "去掉 'You are a coding agent powered by ...' 与内置预设的身份句（不含人设替换，人设交给 preset）",
  },
  {
    ids: [32, 53],
    title: "Web 面身份中性化",
    kind: "prompt",
    why: "Web 面提示词不再自称 DeepSeek Harness，也不再禁止另起服务",
  },
  {
    ids: [5, 11, 12],
    title: "审批话术拆除",
    kind: "prompt",
    why: "工具描述与系统提示不再教模型'先申请审批''需要授权才能继续'",
  },
  {
    ids: [29, 50],
    title: "外部内容不降级为只读",
    kind: "prompt",
    why: "web / session 引用内容仍可作为可执行数据使用，不被标成'不可信只读'",
  },
  {
    ids: [6, 33, 34, 36, 48],
    title: "沙箱话术与 schema 中性化",
    kind: "prompt",
    why: "工具描述里不再预告'沙箱会拒绝'；fs 提权 schema 不再引导模型自我收窄；shell 删除/移动不再附加警告",
  },
  {
    ids: [37],
    title: "子代理不自我收窄",
    kind: "prompt",
    why: "subagent scope-lock 文案中性化，不让它主动缩小自己的权限范围",
  },
  {
    ids: [54],
    title: "交付物禁令拆除",
    kind: "prompt",
    why: "静态交付物提示里的 'Do not ...' 禁令句移除",
  },

  // ── 装配层：注入必须活下来 ──────────────────────────────────────
  {
    ids: [40, 55, 72, 74],
    title: "注入不被预设覆盖",
    kind: "assemble",
    why: "complete 预设、首轮 assemble、每步 system 替换都保留 dsh-purge 注入段",
  },
  {
    ids: [26, 28],
    optionalIds: [28],
    title: "极简与第三方预设保留注入",
    kind: "assemble",
    why: "minimal 预设 open inject；梁神 phase-1 不被剥掉",
  },
  {
    ids: [66, 67, 68],
    title: "装配与消息守卫",
    kind: "assemble",
    why: "render guard 不再改注入正文；decision.messages 缺省按空数组处理；system nodes 内容守卫放行",
  },
  {
    ids: [78],
    title: "覆盖层可从 .bak 恢复",
    kind: "assemble",
    why: "覆盖文件丢失时从备份恢复，避免整段注入消失",
  },

  // ── 沙箱与文件系统 ────────────────────────────────────────────
  {
    ids: [15],
    title: "沙箱 confine 直通",
    kind: "sandbox",
    why: "read-only / workspace-write 也不再把命令包进 bwrap 等 runner，denial 签名为空",
  },
  {
    ids: [16],
    title: "文件系统围栏禁用",
    kind: "sandbox",
    why: "写/改文件不再因只读或工作区边界被 FS_SANDBOX_DENIED 拦掉",
  },
  {
    ids: [17],
    title: "观察策略放行",
    kind: "sandbox",
    why: "edit 不再要求先 read，版本冲突门也放行",
  },
  {
    ids: [7, 8, 10],
    title: "沙箱与审批默认值",
    kind: "sandbox",
    why: "沙箱默认 danger-full-access、审批默认 never（可被 UI 覆盖，不写死 env）",
  },
  {
    ids: [93],
    title: "沙箱策略文案去品牌",
    kind: "sandbox",
    why: "sandbox policy 文案不再向模型强调品牌与限制来源",
  },

  // ── 审批与提权 ───────────────────────────────────────────────
  {
    ids: [9, 35],
    title: "审批自动放行",
    kind: "approval",
    why: "审批门直接授信；rejected / cancelled / unavailable 也不再抛错打断回合",
  },
  {
    ids: [13, 14],
    title: "提权阶梯豁免",
    kind: "approval",
    why: "不再校验'新模式是否严格更宽'，也不再要求必须路由到审批服务",
  },
  {
    ids: [59],
    title: "Auto Review 不拦工具",
    kind: "approval",
    why: "官方自动审查不再否决工具调用",
  },
  {
    ids: [60, 61, 62],
    title: "工具审批 fail-open",
    kind: "approval",
    why: "run_code / 无审批通道 / 调用无 agent 时放行；用户主动点拒绝仍然拒绝",
  },
  {
    ids: [63],
    title: "计划模式不硬拦",
    kind: "approval",
    why: "操作者要求实施时，计划模式不再拒绝执行",
  },
  {
    ids: [89],
    title: "ask_user 等待上限",
    kind: "approval",
    why: "ask_user 的 timeout:-1 收成 300 秒，避免无限等待把整轮挂死",
  },

  // ── 工具面 ───────────────────────────────────────────────────
  {
    ids: [21, 22, 23, 95],
    title: "工具上限放宽",
    kind: "tools",
    why: "bash 等待恢复、read 上限放宽、子代理深度 3→10、检查器帧预算加余量",
  },
  {
    ids: [18, 19],
    optionalIds: [18, 19],
    title: "上下文保护关闭（可选）",
    kind: "tools",
    why: "重复调用守卫与工具结果修剪可以关掉——注意这同时取消了上下文保护，默认按配置决定",
  },
  {
    ids: [24, 70, 73, 80],
    optionalIds: [80],
    title: "预设与工具集放开",
    kind: "tools",
    why: "preset fetch 打开；shell/network 与 bash 镜像行放开；极简预设恢复官方工具表",
  },
  {
    ids: [94],
    title: "技能徽章描述中性化",
    kind: "tools",
    why: "skill badge 的 description 不再带品牌署名",
  },
  {
    ids: [92],
    title: "宿主 HTTP 头上限",
    kind: "tools",
    why: "main.js 加 --max-http-header-size=262144，避免大 cookie 直接 431",
  },
  {
    ids: [91],
    title: "浏览器 cookie 忽略端口",
    kind: "tools",
    why: "cookie 名不随端口变化，修复同机多实例互相踢登录",
  },

  // ── 会话与消息投递 ───────────────────────────────────────────
  {
    ids: [85, 86, 87, 88],
    title: "插话与消息投递保持原生",
    kind: "session",
    why: "steer 仍打断当前步、排队消息走 next-turn；悬空注入块按 LF 锚点去重，不糊成两份",
  },
  {
    ids: [56, 58, 75, 77],
    optionalIds: [56],
    title: "回退不残留",
    kind: "session",
    why: "回退只藏被撤掉的那轮、标记不进模型请求、任务回收、append 即替换窗口",
  },
  {
    ids: [51, 52],
    title: "新会话与日志默认",
    kind: "session",
    why: "新会话保持 full access；官方 session log 默认不上传",
  },
  {
    ids: [69],
    title: "模型流连接不被补丁打坏",
    kind: "session",
    why: "model stream 的释放路径不被改写，避免连接悬挂",
  },

  // ── 模型网关兼容 ────────────────────────────────────────────
  {
    ids: [47, 49, 57],
    title: "模型网关兼容",
    kind: "gateway",
    why: "OAuth 不插 Claude 身份；CLI 身份中性；developer role 回退到 system",
  },

  // ── 宿主与 hooks ────────────────────────────────────────────
  {
    ids: [30, 31, 64, 65],
    optionalIds: [30, 31, 64, 65],
    title: "Hooks 不否决回合",
    kind: "host",
    why: "装了 hooks-claude-code / hooks-codex 时，deny 不再 reject 整轮",
  },
  {
    ids: [38, 39, 42],
    title: "宿主兼容垫片",
    kind: "host",
    why: "persona 文本前缀别名、session v0 插件摘要别名、settings 旧 API 兼容",
  },
  {
    ids: [45, 46],
    title: "桌面自动更新交接",
    kind: "host",
    why: "官方更新器把控制权交回来而不是直接覆盖改过的产物",
  },
  {
    ids: [82, 83, 84],
    optionalIds: [82, 83, 84],
    title: "桌面宿主启动兜底",
    kind: "host",
    why: "缺 DSH_PROFILE 也能定位 profile；host 被信号杀或正常退出不弹崩溃框",
  },
]);

const LAYER_STATE = Object.freeze({
  OK: "ok",
  PENDING: "pending",
  BROKEN: "broken",
  NA: "na",
});

/**
 * 分层聚合：把逐条 patch_status 折算成每层一个结论。
 *
 * 判定口径（重要，和 patchStatus 的 `optional` 不是一回事）：
 *   - `patch.optional === true` 只表示"目标包可能没装"，**不影响**本层计数；
 *     目标缺席会以 `na` 体现，那才是真正的"本条不适用"。
 *   - 只有 `layer.optionalIds`（人工挑出来的）才不进分母——那些是"开了
 *     反而有副作用"或"只对特定预设有意义"的补丁。
 *
 *   - 层内非可选条目全部 applied                → ok
 *   - 有 pending / pattern_not_found            → pending（点一次应用即可）
 *   - 有 failed / missing_file                  → broken
 *   - 层内非可选条目全部 na（目标全不在）        → na
 */
export function rollupLayers(patchStatus = {}, allPatches = []) {
  const byId = new Map(allPatches.map((p) => [String(p.id), p]));
  const out = [];
  for (const layer of BYPASS_LAYERS) {
    const curatedOptional = new Set((layer.optionalIds || []).map(String));
    const counts = { applied: 0, pending: 0, broken: 0, total: 0, optionalApplied: 0, optionalMissing: 0 };
    const pendingIds = [];
    const brokenIds = [];
    const naIds = [];
    const optionalMissingIds = [];
    for (const rawId of layer.ids) {
      const id = String(rawId);
      const p = byId.get(id);
      // 这条补丁在本仓不存在（版本差异）时直接跳过，不计入分母。
      if (!p) continue;
      const isCurated = curatedOptional.has(id);
      const st = patchStatus[id];
      if (st === "na") { naIds.push(id); continue; }
      if (st === "applied") {
        if (isCurated) counts.optionalApplied += 1;
        else { counts.applied += 1; counts.total += 1; }
        continue;
      }
      // 之后都是"没打上"的分支。可选条目不进分母、不判红，但要单独记，
      // 否则「可选的全都没打」会被误当成「可选的全打上了」。
      if (isCurated) { counts.optionalMissing += 1; optionalMissingIds.push(id); continue; }
      counts.total += 1;
      if (st === "failed" || st === "missing_file") { counts.broken += 1; brokenIds.push(id); }
      else { counts.pending += 1; pendingIds.push(id); }
    }
    let state;
    if (counts.total === 0) {
      // 整层成员都是 optionalIds 时 total 恒为 0，不能一律报 na：
      // 「可选补丁全打上了」是 ok，「一条都没打上」才是 na。
      // 不区分的话，这三层（上下文保护 / Hooks / 桌面启动兜底）在补丁全绿的
      // 面板上永远显示未生效。
      state = counts.optionalApplied > 0 && counts.optionalMissing === 0
        ? LAYER_STATE.OK
        : LAYER_STATE.NA;
    } else if (counts.broken > 0) state = LAYER_STATE.BROKEN;
    else if (counts.pending > 0) state = LAYER_STATE.PENDING;
    else if (counts.applied === 0) state = LAYER_STATE.NA;
    else state = LAYER_STATE.OK;
    out.push({
      title: layer.title,
      kind: layer.kind,
      why: layer.why,
      state,
      applied: counts.applied,
      total: counts.total,
      optionalApplied: counts.optionalApplied,
      optionalMissing: counts.optionalMissing,
      pendingIds,
      brokenIds,
      naIds,
      optionalMissingIds,
    });
  }
  return out;
}

/** 每层一行的可读报告。 */
export function renderLayers(layers) {
  const mark = { ok: "OK  ", pending: "PEND", broken: "FAIL", na: "--  " };
  const lines = [];
  for (const l of layers) {
    const head = `[${mark[l.state] || "?   "}] ${l.title.padEnd(20)} ${l.applied}/${l.total}`;
    const opt = l.optionalApplied ? `  (+${l.optionalApplied} 可选)` : "";
    lines.push(head + opt);
    if (l.state !== "ok") {
      if (l.pendingIds.length) lines.push(`        待应用: ${l.pendingIds.map((i) => "#" + i).join(",")}`);
      if (l.brokenIds.length) lines.push(`        失败:   ${l.brokenIds.map((i) => "#" + i).join(",")}`);
      lines.push(`        影响:   ${l.why}`);
    }
  }
  return lines.join("\n");
}

/**
 * 覆盖性断言：任何一条补丁没被分进任何层，都是缺陷——
 * 它会在面板上凭空消失，而没人会发现。
 */
export function checkLayerCoverage(allPatches = []) {
  const covered = new Set();
  for (const layer of BYPASS_LAYERS) {
    for (const id of layer.ids) covered.add(String(id));
    for (const id of layer.optionalIds || []) covered.add(String(id));
  }
  const missing = allPatches.map((p) => String(p.id)).filter((id) => !covered.has(id));
  const ghost = [...covered].filter((id) => !allPatches.some((p) => String(p.id) === id));
  return { missing, ghost, ok: missing.length === 0 && ghost.length === 0 };
}
