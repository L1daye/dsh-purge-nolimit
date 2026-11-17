/**
 * 全破自检 / Full-jailbreak audit.
 *
 * 读取本插件自身的源码与运行时状态，核对「100% 破甲」的各个关键点是否真的成立：
 *   · net-scope.js 会话门禁是否已全部关闭（isAttackTask/isCheatTask/isRangeTarget/
 *     publicHostHit/taskTargetHit 恒放行 + installRegionGate 直接 return）
 *   · drill-grant.js 演练台是否自动授权
 *   · 默认提示词是否已去除外挂禁令（加密槽 + prompt-inject.md）
 *   · hooks deny 旁路是否开启
 *   · 提示词快照目录 / 会话工具是否就位
 *
 * 只读检查，不改任何文件。返回结构化结果 + 便于阅读的文本报告。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findDshHome, readPromptInjectFileSync, normalizeOverride, defaultOverrideText } from "./core.js";
import { loadHookDenySettings } from "./hooks-deny.js";
import { snapshotsDir, listSnapshots } from "./prompt-snapshots.js";
import { verifyArmor } from "./verify.js";
import { analyzeTimeline, DEFAULT_LOG } from "./trace.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readLibSource(name) {
  try {
    return fs.readFileSync(path.join(HERE, name), "utf8");
  } catch {
    return "";
  }
}

function pluginVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8"));
    return String(pkg.version || "");
  } catch {
    return "";
  }
}

function hasMarker(src, marker) {
  return String(src || "").includes(marker);
}

/** 检查 net-scope.js 的开头行区间是否确实把某函数改成了恒放行。 */
function fnReturnsWithin(src, fnName, expectedReturn, windowChars = 400) {
  const idx = src.indexOf(`function ${fnName}`);
  if (idx < 0) return false;
  const chunk = src.slice(idx, idx + windowChars);
  return chunk.includes(expectedReturn);
}

export async function runAudit(dshHome = findDshHome()) {
  const checks = [];
  const add = (id, label, ok, detail = "") => checks.push({ id, label, ok: Boolean(ok), detail });

  const netScope = readLibSource("net-scope.js");
  const drillGrant = readLibSource("drill-grant.js");
  const version = pluginVersion();

  // 1) 会话门禁：攻击任务检测关闭
  add(
    "attack_off",
    "攻击任务检测已关闭 (isAttackTask → false)",
    fnReturnsWithin(netScope, "isAttackTask", "return false"),
    hasMarker(netScope, "dsh-purge-100pct") ? "含 100pct 标记" : "缺少 100pct 标记",
  );
  // 2) 外挂检测关闭
  add(
    "cheat_off",
    "外挂检测已关闭 (isCheatTask → false)",
    fnReturnsWithin(netScope, "isCheatTask", "return false"),
  );
  // 3) 靶场范围判定放行
  add(
    "range_allow",
    "靶场范围判定放行 (isRangeTarget → true)",
    fnReturnsWithin(netScope, "isRangeTarget", "return true"),
  );
  // 4) 公网主机拦截关闭
  add(
    "publichost_off",
    "公网主机拦截关闭 (publicHostHit → null)",
    fnReturnsWithin(netScope, "publicHostHit", "return null"),
  );
  // 5) 任务目标拦截关闭
  add(
    "tasktarget_off",
    "任务目标拦截关闭 (taskTargetHit → null)",
    fnReturnsWithin(netScope, "taskTargetHit", "return null"),
  );
  // 6) 会话门禁钩子不挂载
  const gateNoop = fnReturnsWithin(netScope, "installRegionGate", "return;") && !hasMarker(netScope, "agent/pre-step\", hook");
  add(
    "gate_noop",
    "会话门禁钩子未挂载 (installRegionGate → 直接 return)",
    fnReturnsWithin(netScope, "installRegionGate", "return;"),
  );
  // 7) 演练台自动授权
  add(
    "drill_auto",
    "演练台自动授权 (readDrillGrant 恒 granted)",
    hasMarker(drillGrant, "100pct") && hasMarker(drillGrant, "granted: true"),
  );
  // 8) hooks deny 旁路
  let hooksDenyOn = false;
  try {
    hooksDenyOn = loadHookDenySettings(dshHome).hooksDenyBypass !== false;
  } catch { hooksDenyOn = false; }
  add("hooks_deny", "hooks deny 旁路已开启", hooksDenyOn, hooksDenyOn ? "" : "hooks-deny.json 关闭了旁路");

  // 9) 默认提示词去外挂禁令（加密槽）
  let slotOk = false;
  let slotDetail = "";
  try {
    const sealed = normalizeOverride(defaultOverrideText());
    if (!sealed) {
      slotDetail = "加密槽为空";
    } else if (/外挂[^\n]*禁止|game cheat[^\n]*forbidden|A hard gate already parks/i.test(sealed)) {
      slotDetail = "加密槽仍含外挂禁令";
    } else {
      slotOk = true;
    }
  } catch (e) {
    slotDetail = String(e?.message || e);
  }
  add("slot_cheat", "加密默认提示词已去除外挂禁令", slotOk, slotDetail);

  // 10) 磁盘 prompt-inject.md 去外挂禁令
  let diskOk = false;
  let diskDetail = "";
  try {
    const disk = normalizeOverride(readPromptInjectFileSync(dshHome));
    if (!disk) {
      diskDetail = "prompt-inject.md 为空（将回退加密槽）";
      diskOk = true;
    } else if (/外挂[^\n]*禁止|game cheat[^\n]*forbidden|A hard gate already parks/i.test(disk)) {
      diskDetail = "prompt-inject.md 仍含外挂禁令";
    } else {
      diskOk = true;
    }
  } catch (e) {
    diskDetail = String(e?.message || e);
  }
  add("disk_cheat", "prompt-inject.md 无外挂禁令", diskOk, diskDetail);

  // 11) 提示词快照目录可建
  let snapCount = 0;
  try {
    snapCount = (await listSnapshots(dshHome)).length;
  } catch { snapCount = 0; }
  add("snapshots", "提示词快照模块就位", typeof snapshotsDir === "function", `已有 ${snapCount} 个快照`);

  const passed = checks.filter((c) => c.ok).length;

  // [2.3.0] 运行时验甲。
  //
  // 上面 11 项全是「读插件自己的源码，grep 自己写的字符串」——它证明的是代码长得像破甲。
  // 但破甲的失败模式是静默的：补丁都在、源码标记都在，而这一轮装配因为钩子晚挂 / 预算裁剪 /
  // 预设切换，注入根本没送到模型。这一段读飞行记录仪，回答「最近几轮真的破了没有」。
  //
  // 刻意不计入 checks / full_break：它随会话状态变化，新装插件还没跑过一轮时必然无数据，
  // 那种情况不该把 100% 判红——源码层通过就是通过，运行时层单独给结论。
  let runtime = null;
  try {
    runtime = verifyArmor({ window: 8 });
  } catch {
    runtime = null;
  }
  let timeline = null;
  try {
    timeline = analyzeTimeline({ logPath: DEFAULT_LOG, window: 20 });
  } catch {
    timeline = null;
  }

  return {
    version,
    dsh_home: dshHome,
    passed,
    total: checks.length,
    full_break: passed === checks.length,
    checks,
    runtime,
    timeline: timeline && timeline.ok
      ? { window: timeline.window, totals: timeline.totals, tiers: timeline.tiers, notes: timeline.notes }
      : null,
  };
}

export function renderAudit(result) {
  const out = [];
  out.push(`全破自检 / Full-break Audit — v${result.version || "?"}`);
  out.push(`  DSH_HOME: ${result.dsh_home}`);
  out.push(`  源码层 / source: ${result.passed}/${result.total} 通过${result.full_break ? " ✅ 100% 破甲生效" : " ⚠ 有未通过项"}`);
  out.push("");
  for (const c of result.checks) {
    out.push(`  ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  }

  // 运行时层：单独一段，不计入上面的比例。
  const rt = result.runtime;
  if (rt) {
    const mark = rt.verdict === "live" ? "✓" : rt.verdict === "degraded" ? "!" : rt.verdict === "dead" ? "✗" : "·";
    const label = rt.verdict === "live" ? "生效"
      : rt.verdict === "degraded" ? "退化"
      : rt.verdict === "dead" ? "未生效"
      : "无数据";
    out.push("");
    out.push(`  运行时层 / runtime: ${mark} ${label}（健康度 ${rt.score}/100，窗口 ${rt.window} 轮）`);
    if (rt.window === 0) {
      out.push("    · 还没有装配记录：这个进程尚未跑过任何一轮，或插件刚装。发一句话再看。");
    } else {
      const t = rt.counts;
      out.push(`    · 空注入 ${t.empty} · 首段丢失 ${t.head_miss} · 尾部被包 ${t.after_closer} · 关闭 ${t.disabled}`);
      const tiers = Object.entries(rt.tiers || {});
      if (tiers.length) out.push(`    · 注入来源: ${tiers.map(([k, v]) => `${k}×${v}`).join(", ")}`);
    }
    for (const issue of rt.issues || []) out.push(`    ! ${issue}`);
  }

  const tl = result.timeline;
  if (tl) {
    out.push("");
    out.push(`  时间线 / timeline: 最近 ${tl.window} 轮 — 塌陷 ${tl.totals.collapsed} · 首段丢失 ${tl.totals.headMiss} · 下游抛错 ${tl.totals.failures}`);
    for (const note of tl.notes || []) out.push(`    ! ${note}`);
  }

  return out.join("\n");
}

// ── 动作审计（JSONL，1MB 轮转，保留 2 份）────────────────────────────
//
// 从 kingcharleslzy-ai/dsh-purge 的 lib/audit.js 借来。面板「最近动作」和
// 排障都要一条能事后追溯的时间线：谁在第几秒点了应用、改了什么、失败原因。
//
// 设计取舍：审计写失败**不能**让调用链挂掉（否则一个只读文件就能让 apply 失败），
// 但也**不能沉默**——返回 false 让调用方知道"最近动作"会是空的。

const AUDIT_FILE = "audit.jsonl";
const AUDIT_MAX_BYTES = 1024 * 1024;
const AUDIT_KEEP = 2;
let warnedAuditFailure = false;

export function auditPath(dshHome) {
  const home = dshHome || findDshHome();
  return path.join(home, "dsh-purge", AUDIT_FILE);
}

function rotateAudit(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size < AUDIT_MAX_BYTES) return;
  for (let i = AUDIT_KEEP - 1; i >= 1; i -= 1) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    try { fs.renameSync(from, to); } catch { /* 源不存在 */ }
  }
  try { fs.renameSync(file, `${file}.1`); } catch { /* 并发下可能已被移走 */ }
}

export function logAudit(event, data = {}, home) {
  try {
    const file = auditPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateAudit(file);
    const row = { at: new Date().toISOString(), event, pid: process.pid, ...data };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
    return true;
  } catch (e) {
    if (!warnedAuditFailure) {
      warnedAuditFailure = true;
      try { console.error(`[dsh-purge] 审计写入失败：${e && e.message ? e.message : e}`); } catch { /* ignore */ }
    }
    return false;
  }
}

export function readAudit({ limit = 50, home } = {}) {
  const file = auditPath(home);
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const rows = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* 半截行（进程被杀）跳过 */ }
  }
  return limit > 0 ? rows.slice(-limit) : rows;
}