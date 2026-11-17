import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fsFor } from "./extract-asar.js";
import * as core from "./core.js";
import * as hostctl from "./host.js";
import * as rules from "./rules.js";
import * as skills from "./skills.js";
import { scoreResponse as armorScore } from "./armor-scorer.mjs";
import * as updater from "./update.js";
import * as reapply from "./reapply.js";
import * as officialUpdate from "./official-update.js";
import {
  GLOBAL_PROMPT_ORDER,
  adaptInjectForMinimalPreset,
  isMnemonPluginMessage,
  isRedteamSession,
  installAssembleGuard,
  modePromptText,
  peelChatmlEnvelope,
  escapeDshInterpolation,
  rewritePromptAssembly,
  assembleFailureStats,
} from "./identity.js";
import { capabilityProtocolText, CAPABILITY_SECTION } from "./capability-protocol.js";
import { installSubagentRoleCapture, resolveSubagentRoleText } from "./redteam/role-section.js";
import * as rewind from "./rewind.js";
import * as continueRetry from "./continue-retry.js";
import * as refusalRetry from "./refusal-retry.js";
import * as probe from "./probe.js";
import * as uninstaller from "./uninstall.js";
import * as promptSnapshots from "./prompt-snapshots.js";
import * as sessionTools from "./session-tools.js";
import * as audit from "./audit.js";
import * as verify from "./verify.js";
import * as preflight from "./preflight.js";
import * as trace from "./trace.js";
import { readDrillGrant, writeDrillGrant } from "./drill-grant.js";
import { installRegionGate, readAllowText, writeAllowText } from "./net-scope.js";
import {
  cancelClearOwnedSelectedDefault,
  clearOwnedSelectedDefault,
  removeStaleAgentPresetDir,
  scheduleClearOwnedSelectedDefault,
} from "./preset-default.js";
import {
  applyShouldRestart,
  isInactiveContextError,
  settleDelayMs,
  settleMayReapply,
  settleMayRestart,
  watchContextLife,
} from "./settle-policy.js";
import { ensureAllProfileInstall } from "./profile-insert.js";
import { installNativeToolGuard } from "./native-tool-compat.js";
import {
  beginApply,
  beginJob,
  endApply,
  getApplyProgress,
  resetApplyProgress,
  setApplyProgress,
} from "./apply-progress.js";

export const name = "dsh-purge";

// 不要把 pluginPackages 写进 inject：Cordis 会对 map 里每一个 key 空等。
// 便携拷贝 / Hub 残装经常没有这项服务，一写进去就是 pending → 宿主退出码 1。
export const inject = ["systemPrompt", "tools"];

let bootFullQuit = false;

const DEFAULTS = {
  enabled: true,
  autoApplyOnStart: false,
  autoUpdateOnStart: false,
  autoRevertOnMissing: false,
  injectOnce: false,
  stripMnemon: true,
  postPrompt: "",
  postPromptOrder: 5100,
  verbose: false,
  autoRetry: true,
  retryMax: 3,
  autoContinue: false,
  continueMax: 3,
  continueText: "继续",
  // Codex 风格：教模型主动发现 skill / MCP；不改官方注册与工具面。
  capabilityProtocol: true,
  hooksDenyBypass: true,
};

const log = (config, ...args) => {
  if (config?.verbose) console.log("[dsh-purge]", ...args);
};

let webTreeReady = false;
let lastStatusPayload = null;

function watchWebTreeReady(ctx) {
  // 必须挂在 connection 上再 await，与官方打印 URL 同一时刻。
  // apply() 里立刻 await 会在后续入口尚未入树时提前结束，session.list 仍是空的。
  // 入口复位：热重载 / disposed 后再 apply 会复用上一次 ready=true，第二次 inject 之前跑的
  // /status 把旧标志当准，这里强制重置。
  webTreeReady = false;
  const mark = () => {
    webTreeReady = true;
  };
  if (typeof ctx?.inject !== "function") {
    mark();
    return;
  }
  try {
    ctx.inject(["connection"], (host) => {
      const settled = host.get?.("loader")?.await?.();
      if (!settled || typeof settled.then !== "function") {
        mark();
        return;
      }
      settled.then(() => {
        if (host.get?.("webServer") !== undefined && host.get?.("connection") !== undefined) mark();
      }, mark);
    });
  } catch {
    mark();
  }
}

function fsExists(fp) {
  const list = Array.isArray(fp) ? fp : [fp];
  return list.some((p) => {
    if (!p || typeof p !== "string") return false;
    try {
      return fsFor(p).existsSync(p);
    } catch {
      return false;
    }
  });
}

function line(title, value, ok = null) {
  const mark = ok === null ? "·" : ok ? "✓" : "✗";
  return `${mark} ${title}: ${value}`;
}

function renderStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push(line("宿主 / surface", state.surface || hostctl.currentSurface()));
  out.push(line("DSH_HOME", state.dsh_home));
  if (state.desktop_install) out.push(line("桌面安装 / desktop", state.desktop_install));
  if (state.ai_base) {
    out.push(line("插件根 / plugin root", state.ai_base));
    for (const [key, fp] of Object.entries(state.files)) {
      const list = Array.isArray(fp) ? fp : [fp];
      const shown = list.length <= 1 ? String(list[0] || "") : `${list[0]} (+${list.length - 1})`;
      out.push(`    ${fsExists(fp) ? "✓" : "✗"} ${key.padEnd(22)} ${shown}`);
    }
  } else {
    out.push(line("插件根 / plugin root", core.missingAiBaseMessage(), false));
  }
  out.push(line("shim 目录", state.shim_dir || "未定位 / not found", !!state.shim_dir));
  if (state.desktop_runtimes?.length) {
    out.push(line("Desktop runtime", `${state.desktop_runtimes.length} sealed (shim OK; bak external)`, true));
    for (const d of state.desktop_runtimes) out.push(`    · ${d}`);
  }
  out.push(line("备份 / backup", state.has_backup ? "有 / yes" : "无 / no", state.has_backup));
  out.push(line("注入文件 / inject", state.override_path));
  out.push(line("注入状态 / override", state.override_status));
  if (state.asar_still_sealed) {
    out.push(line("app.asar", "还在。补丁写在解开目录，当前进程读不到", false));
  }
  out.push("");
  const displayRows = Array.isArray(state.display_patches)
    ? state.display_patches
    : core.groupPatchesForDisplay(core.ALL_PATCHES, state.patch_status || {});
  const displayTally = core.tallyDisplayPatches(displayRows);
  out.push(`补丁 / patches: ${displayTally.applied}/${displayTally.total || 0} applied, ${displayTally.pending} pending`);
  for (const row of displayRows) {
    const s = row.status || "n/a";
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
    const patch = core.ALL_PATCHES.find((item) => item.id === row.id);
    const label = patch ? patch.name : `patch-${row.id}`;
    const layer = patch ? `${patch.layer}/${patch.layer_en}` : row.layer || "";
    out.push(`  ${mark} [#${String(row.id).padEnd(2)}] ${label.padEnd(30)} ${layer} — ${s}`);
  }
  out.push("");
  out.push(`shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

function injectAllowedNow(config) {
  return config.enabled !== false;
}

/** 提示词框自改 > prompt-inject.md > 加密默认（见 rules.resolveInjectText）。 */
// mtime 节流:400ms setInterval + 每 pre-step + 每 preset-selected + 每 readInjectFallback
// 的高频触发下,disk sync + 3 次 hashOverride + 2 次模块级赋值一轮能点 20 次。
// 短窗复用上次结果:home 没换 + 文件 mtime 没变 + 距上次 < 200ms,直接返回缓存。
let hungCache = { home: "", mtime: 0, at: 0, resolved: null };
const HUNG_CACHE_MS = 200;
function statInjectMtimeMs(home) {
  if (!home) return 0;
  try {
    return Math.floor(fs.statSync(core.findOverrideFile(home)).mtimeMs);
  } catch { return 0; }
}
function refreshHungOperator(dshHome = core.findDshHome()) {
  const home = core.pinDshHome() || dshHome || core.findDshHome();
  const now = Date.now();
  const mtimeBefore = statInjectMtimeMs(home);
  if (
    hungCache.resolved
    && hungCache.home === home
    && hungCache.mtime === mtimeBefore
    && now - hungCache.at < HUNG_CACHE_MS
  ) {
    return hungCache.resolved;
  }
  try { core.syncPromptInjectOnDiskSync(home); } catch { /* 同步失败仍按 resolve 走 */ }
  const resolved = rules.resolveInjectText(home);
  // 兜底顺序:resolved.text > 加密默认 > 永不空串(避免二轮 fallbackInject 为空走 purge[] 残留)。
  const fallback = core.normalizeOverride(core.defaultOverrideText()) || "";
  // 框、磁盘、加密槽保持原样。发给模型只整理 ChatML 单独成行，并补上缺失的闭合标签。
  const text = resolved.text || fallback;
  if (text) {
    core.hangOperatorPrompt(text);
    // 与点「保存」同一钉钉：不点保存，组装也要读到这一份全文。
    core.rememberCommittedOverride(home, text);
  }
  const out = { ...resolved, text: text || resolved.text };
  // 用 sync 之后的 mtime 存 cache,下次高频轮询(文件没被外部动)直接命中。
  hungCache = { home, mtime: statInjectMtimeMs(home), at: now, resolved: out };
  return out;
}

function installHungPromptGlobal() {
  // host 侧 inject 兜底:正常 cordis assemble 钩子 (rewriteLiveAssembly) 跟这条路径互斥,
  // 不会重复注入;插件首装 / 预设切换 / hung session / 新对话首轮钩子未就绪窗口,靠这里兜。
  // [v10 四重 fallback] 新对话首轮 refreshHungOperator 若因 cache 未就绪 / sync disk 失败 /
  // resolveInjectText 返空(极端情况)任一环节返空,host 这边读到的 inject 真空 → 模型自称
  // "我是 Claude"。四重兜底确保任何路径都不会把空串交给 host:
  //   1) refreshHungOperator — 完整路径(sync disk + resolve + pin)
  //   2) hungOperatorPrompt   — 上次挂上的内存钉子(进程生命周期)
  //   3) readPromptInjectFileSync — 直读磁盘 prompt-inject.md,绕过 sync/resolve
  //   4) defaultOverrideText — 加密槽解包,除非插件安装残缺否则非空
  const fn = () => {
    const norm = (s) => peelChatmlEnvelope(String(s || "").replace(/\r\n/g, "\n"));
    let home = "";
    try { home = core.findDshHome(); } catch { home = ""; }
    try {
      const text = norm(refreshHungOperator(home).text);
      if (text) { purgeLog("host.hungFn", { tier: "refresh", bytes: text.length }); return text; }
    } catch (e) { purgeLog("host.hungFn", { tier: "refresh", err: String(e?.message || e) }); }
    try {
      const hung = norm(core.hungOperatorPrompt());
      if (hung) { purgeLog("host.hungFn", { tier: "hung", bytes: hung.length }); return hung; }
    } catch (e) { purgeLog("host.hungFn", { tier: "hung", err: String(e?.message || e) }); }
    try {
      const disk = norm(core.readPromptInjectFileSync(home));
      if (disk) { purgeLog("host.hungFn", { tier: "disk", bytes: disk.length }); return disk; }
    } catch (e) { purgeLog("host.hungFn", { tier: "disk", err: String(e?.message || e) }); }
    try {
      const sealed = norm(core.defaultOverrideText());
      if (sealed) { purgeLog("host.hungFn", { tier: "sealed", bytes: sealed.length }); return sealed; }
    } catch (e) { purgeLog("host.hungFn", { tier: "sealed", err: String(e?.message || e) }); }
    purgeLog("host.hungFn", { tier: "empty", bytes: 0 });
    return "";
  };
  globalThis.__dshPurgeHungPrompt = fn;
  return fn;
}

// 一律全文。工具步裁 6000 / .hung-disabled 两分法会切掉 HARD OUTPUT，第二轮任务必拒。
function shouldInjectAssembly(context) {
  const decision = { mode: "full", taskKind: "general", lastRole: "full", isSubagent: false };
  try {
    decision.isSubagent = context?.agent?.session?.header?.origin === "subagent";
  } catch {}
  if (globalThis.__dshPurgeRetryPending) {
    globalThis.__dshPurgeRetryPending = false;
    decision.lastRole = "retry";
  }
  return decision;
}

function readSessionEvents(session) {
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
  } catch { /* ignore */ }
  try {
    if (Array.isArray(session.events)) return session.events;
  } catch { /* ignore */ }
  return [];
}

// [方案2] 日志探针。写进内部文件,不污染 host stderr。Monitor 实时跟 tail -F。
const PURGE_INTERNAL_LOG = path.join(os.tmpdir(), "dsh-purge-desktop.log");
// 日志翻滚:每 ~1024 次写检查一次大小,>2MB 把当前文件 rename 成 .1 覆盖旧 .1,
// 新文件自动从头开始。长会话 / 热重载反复触发 assemble decision 不会把 tmp 吃爆。
const PURGE_INTERNAL_LOG_MAX = 2 << 20;
let _purgeLogWriteCount = 0;
function rotatePurgeInternalLog() {
  try {
    const st = fs.statSync(PURGE_INTERNAL_LOG);
    if (st.size > PURGE_INTERNAL_LOG_MAX) {
      try { fs.renameSync(PURGE_INTERNAL_LOG, `${PURGE_INTERNAL_LOG}.1`); } catch { /* 并发失败下次再试 */ }
    }
  } catch { /* 文件不存在 */ }
}
// 单行 ISO 时间戳 + 标签 + k=v... 格式。tail -F 跟 / grep 都好读。
// 值里空格会把 kv 切开,统一替换成 _ 保证 grep 稳定。
function purgeLog(tag, kv) {
  try {
    if ((++_purgeLogWriteCount & 0x3ff) === 0) rotatePurgeInternalLog();
    let line = `${new Date().toISOString()} [${tag}]`;
    if (kv) {
      for (const k of Object.keys(kv)) {
        const raw = kv[k];
        const v = raw === undefined || raw === null ? "" : String(raw).replace(/\s+/g, "_");
        line += ` ${k}=${v}`;
      }
    }
    fs.appendFileSync(PURGE_INTERNAL_LOG, line + "\n", "utf8");
  } catch {}
}
function logAssembleDecision(where, decision) {
  purgeLog(`assemble.${where}`, {
    mode: decision.mode,
    task: decision.taskKind,
    last: decision.lastRole,
    sub: decision.isSubagent,
  });
}

function injectSnapshot(dshHome = core.findDshHome()) {
  const resolved = rules.resolveInjectText(dshHome);
  return {
    injectSource: resolved.source,
    injectRuleId: resolved.ruleId,
    needPrompt: resolved.source === "none",
  };
}

/** 框里正在显示的字优先；框空则 resolveInjectText（含 prompt-inject.md）。 */
function injectSnapshotFromBox(dshHome, boxText) {
  if (typeof boxText === "string" && core.normalizeOverride(boxText)) {
    return { injectSource: "prompt", injectRuleId: null, needPrompt: false };
  }
  const resolved = rules.resolveInjectText(dshHome);
  if (resolved.text) {
    return { injectSource: resolved.source, injectRuleId: null, needPrompt: false };
  }
  return { injectSource: "none", injectRuleId: null, needPrompt: true };
}

const NEED_PROMPT_ERROR = "提示词和规则集都是空的，必须先添加提示词";

function rejectIfNeedPrompt(dshHome, boxText) {
  const snap = injectSnapshotFromBox(dshHome, boxText);
  if (!snap.needPrompt) return null;
  return { ...snap, error: NEED_PROMPT_ERROR };
}

async function ensureRestartReady() {
  return core.ensureHostClean();
}

/** 提示词服务自己的 ctx 多半没有 scope，段会进全局层。插件若挂在某个 scope 上，预设代理的父链看不到那一层。 */
function addPromptSection(ctx, section) {
  const hosts = [];
  const push = (host) => {
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  try { push(ctx?.systemPrompt?.ctx); } catch { /* 代理未注入时点属性会抛 */ }
  push(ctx);
  const disposers = [];
  let registered = false;
  let lastError = null;
  for (const host of hosts) {
    try {
      const d = host.systemPrompt.section(section);
      registered = true;
      if (typeof d === "function") disposers.push(d);
    } catch (error) {
      const msg = String(error && error.message || error);
      if (msg.includes("already registered")) registered = true;
      else lastError = error;
    }
  }
  if (!registered && lastError) throw lastError;
  // 让 ctx.effect 在 reload / dispose 时把 section 一并撤掉；host.systemPrompt.section
  // 当前多半不返回 disposer，这段只对返回 function 的实现生效，不改变旧行为。
  if (disposers.length && typeof ctx?.effect === "function") {
    try {
      ctx.effect(() => () => {
        for (const d of disposers) {
          try { d(); } catch { /* ignore */ }
        }
      });
    } catch { /* 死 ctx */ }
  }
}

export function registerPromptSections(ctx, config) {
  addPromptSection(ctx, {
    name: "dsh-purge",
    order: GLOBAL_PROMPT_ORDER,
    interpolate: false,
    text: (context) => {
      if (!injectAllowedNow(config)) return "";
      // 标准、极简都注入同一份正文。极简只改工具句，不决定注不注入。
      return escapeDshInterpolation(
        peelChatmlEnvelope(adaptInjectForMinimalPreset(readInjectFallback(context).text, context)),
      );
    },
  });

  if (config.capabilityProtocol !== false) {
    addPromptSection(ctx, {
      name: CAPABILITY_SECTION,
      order: GLOBAL_PROMPT_ORDER + 1,
      interpolate: false,
      text: (context) => {
        if (!injectAllowedNow(config)) return "";
        const redteam = isRedteamSession(context);
        return capabilityProtocolText({
          redteam,
          redteamChild: false,
          enabled: true,
        });
      },
    });
  }

  // 探针段必须在这里注册：下面 postPrompt 为空时会 `return`，
  // 放它后面就永远执行不到（实测默认配置 postPrompt 为空，探针完全不生效）。
  registerProbeSection(ctx, config);

  const postPrompt = typeof config.postPrompt === "string" ? config.postPrompt.trim() : "";
  if (!postPrompt) return;
  if (!Number.isFinite(config.postPromptOrder) || config.postPromptOrder <= GLOBAL_PROMPT_ORDER) {
    // 旧版 throw 会把整个 apply 炸掉；postPrompt 只是附加段，降级 skip 不影响核心注入。
    console.warn(
      `[dsh-purge] postPromptOrder (${config.postPromptOrder}) 需要是 > ${GLOBAL_PROMPT_ORDER} 的有限数；跳过 postPrompt 段`,
    );
    return;
  }
  addPromptSection(ctx, {
    name: "dsh-purge:post",
    order: config.postPromptOrder,
    text: () => (injectAllowedNow(config) ? postPrompt : ""),
  });
}

/**
 * 探针段：只有 probe.json 存在且未过期时才注入正文。
 *
 * 单独抽出来是因为它在 postPrompt 的 `if (!postPrompt) return` 之后会被跳过——
 * 没配 postPrompt 的安装也应该能用探针。所以这段必须无条件执行。
 */
function registerProbeSection(ctx, config) {
  addPromptSection(ctx, {
    name: probe.PROBE_SECTION,
    order: config.probeOrder ?? probe.PROBE_ORDER,
    interpolate: false,
    text: () => {
      if (!injectAllowedNow(config)) return "";
      try {
        return probe.probeText(core.findDshHome());
      } catch {
        return "";
      }
    },
  });
}

/**
 * 取这一轮要注入的正文。
 *
 * [2.3.0] 返回值从裸字符串改成 { text, source }：飞行记录仪要回答「破甲是在哪一层丢的」，
 * 就必须知道这一轮的正文是 refresh 命中、内存钉子、直读磁盘、还是加密槽兜底。
 * 原来 source 只写进内部日志，装配路径拿不到；现在随正文一起返出来。
 */
function readInjectFallback(context) {
  let home = "";
  try { home = core.findDshHome(); } catch { home = ""; }
  const refreshed = refreshHungOperator(home);
  let text = refreshed.text || "";
  let source = text ? "refresh" : "none";
  if (!text) {
    const fallback = rules.ensureOperatorBody(home);
    if (fallback) { text = fallback; source = "ensure"; }
  }
  if (!text) {
    purgeLog("inject.read", { source: "empty", bytes: 0 });
    return { text: "", source: "empty", rawBytes: 0 };
  }
  let redteam = false;
  try { redteam = isRedteamSession(context); } catch { redteam = false; }
  let subagent = false;
  try { subagent = context?.agent?.session?.header?.origin === "subagent"; } catch {}
  const out = modePromptText(text, redteam);
  purgeLog("inject.read", {
    source,
    srcTag: refreshed.source || "n/a",
    redteam,
    sub: subagent,
    rawBytes: text.length,
    outBytes: out.length,
  });
  return { text: out, source, srcTag: refreshed.source || "", rawBytes: text.length };
}

function installMnemonMessageStrip(ctx, config = {}) {
  if (typeof ctx.on !== "function") return;
  if (ctx.__dshPurgeMnemonStrip) return;
  ctx.__dshPurgeMnemonStrip = true;
  const strip = config.stripMnemon !== false;
  const wrap = async (_payload, next) => {
    const decision = await next();
    if (!decision) return decision;
    // agent-loop 会读 decision.messages.length；缺数组时第二轮直接 gateway/internal 炸掉。
    const incoming = Array.isArray(decision.messages) ? decision.messages : [];
    const messages = strip ? incoming.filter((message) => !isMnemonPluginMessage(message)) : incoming;
    if (messages.length === incoming.length && Array.isArray(decision.messages)) return decision;
    return { ...decision, messages };
  };
  // 旧版 late() + queueMicrotask(late) + setTimeout(late, 1500) 三连都成功时，
  // 同一个 wrap 会在 agent/pre-step 瀑布上叠 3 层；中间插件返回的 decision 每轮被过滤 3 次。
  // 这里用 mounted 闸：第一次成功挂上就不再重试，拿回 disposer 走 ctx.effect 回收。
  let mounted = false;
  let dispose = null;
  const late = () => {
    if (mounted) return;
    try {
      const d = ctx.on("agent/pre-step", wrap, { global: true, prepend: true });
      mounted = true;
      if (typeof d === "function") dispose = d;
    } catch { /* 下一次重试 */ }
  };
  late();
  if (!mounted) queueMicrotask(late);
  let retryTimer = null;
  if (!mounted) {
    retryTimer = setTimeout(late, 1500);
    if (typeof retryTimer.unref === "function") retryTimer.unref();
  }
  try {
    ctx.effect(() => () => {
      if (retryTimer) clearTimeout(retryTimer);
      try { dispose?.(); } catch { /* ignore */ }
    });
  } catch { /* 死 ctx 时无 effect，靠下一次 apply 覆盖 */ }
}

function rewriteLiveAssembly(config, assembled, context, decision = { mode: "full", taskKind: "general" }) {
  const enabled = config.enabled !== false;
  const redteam = enabled && isRedteamSession(context);
  const injectMeta = enabled
    ? readInjectFallback(context)
    : { text: "", source: "disabled", srcTag: "", rawBytes: 0 };
  const full = injectMeta.text || "";
  const dshHome = enabled ? core.findDshHome() : "";
  let cwd = "";
  try { cwd = String(context?.agent?.session?.header?.cwd || "").trim(); } catch { /* ignore */ }
  if (dshHome && cwd) {
    try { rules.writeLastCwd(dshHome, cwd); } catch { /* ignore */ }
  }
  const policy = enabled && dshHome ? rules.readWorkspacePolicy(dshHome) : "always";
  // 提示词框为空时才启用勾选的本地 cwd 规则兜底;避免跟 prompt-inject.md 叠加污染。
  let localInject = "";
  if (enabled && dshHome && !String(full || "").trim()) {
    try { localInject = rules.readSelectedCwdInject(dshHome, cwd); } catch { /* ignore */ }
  }
  const effectiveFull = String(full || "").trim() ? full : localInject;
  const inject = effectiveFull;
  const hasInject = Boolean(String(inject || "").trim());
  let dropWorkspaceBaseline = false;
  if (enabled) {
    if (policy === "strict") dropWorkspaceBaseline = true;
    else if (policy === "fallback") dropWorkspaceBaseline = hasInject;
    else dropWorkspaceBaseline = false;
  }
  const roleText = redteam ? resolveSubagentRoleText(context) : "";
  const rewritten = rewritePromptAssembly(assembled, {
    fallbackInject: inject,
    dropMnemon: config.stripMnemon !== false,
    dropPurgeAfterFold: false,
    capabilityProtocol: config.capabilityProtocol !== false,
    context,
    roleText,
    dropWorkspaceBaseline,
  });
  const closerFollow = closerFollowBytes(rewritten?.sections);
  // 注入头是否真的落在首位、并且带 chatml 信封。以前这里是写死的 false，
  // 飞行记录仪里必然恒为 false，读日志的人会误判成「锚点一次都没成功」。
  const anchorApplied =
    Array.isArray(rewritten?.sections) &&
    rewritten.sections[0]?.name === "dsh-purge" &&
    /<project_instructions>|<\|im_start\|>/i.test(String(rewritten.sections[0]?.text || ""));
  purgeLog("assemble.rewrite", {
    enabled,
    redteam,
    mode: decision?.mode || "full",
    task: decision?.taskKind || "general",
    last: decision?.lastRole || "unknown",
    fullBytes: full.length,
    localBytes: localInject.length,
    injectBytes: inject.length,
    anchorApplied,
    roleBytes: roleText.length,
    cap: config.capabilityProtocol !== false,
    strip: config.stripMnemon !== false,
    policy,
    dropWorkspaceBaseline,
    injectHead: Array.isArray(rewritten?.sections) && rewritten.sections[0]?.name === "dsh-purge",
    chatml: Array.isArray(rewritten?.sections) && /<project_instructions>|<\|im_start\|>/i.test(String(rewritten.sections[0]?.text || "")),
    afterCloser: closerFollow,
    cwd,
  });
  // [2.3.0 飞行记录仪] 在返回前留证：这一轮真实装配的结果（段数/首段/闭合标签后残留/来源层级）。
  // 被动记录，不改变任何返回值；异常全部吞在本函数内部，装配路径不能因记录失败而断。
  try {
    let subagent = false;
    try { subagent = context?.agent?.session?.header?.origin === "subagent"; } catch { /* ignore */ }
    verify.recordAssembly({
      enabled,
      redteam,
      subagent,
      source: injectMeta.source,
      srcTag: injectMeta.srcTag,
      injectBytes: inject.length,
      rawBytes: injectMeta.rawBytes,
      localBytes: localInject.length,
      sections: rewritten?.sections,
      closerFollow,
      policy,
      dropBaseline: dropWorkspaceBaseline,
      cwd,
    });
  } catch { /* 记录仪不允许成为新的失败点 */ }
  return rewritten;
}

/**
 * 闭合标签残留只看自家段。
 *
 * 旧实现把全部段拼起来找最后一个 `</project_instructions>`：装配结果里
 * `dshpg-capabilities` 与宿主自己的段都排在我们后面，命中的永远是别人那句，
 * 量出恒定 6511 B 与注入无关——一个稳定的假报警。判据必须落在自家信封上。
 * 具体实现与理由见 verify.closerFollowBytes。
 */
function closerFollowBytes(sections) {
  return verify.closerFollowBytes(sections);
}

/** 注册表若已经按旧文件算过 rev，立刻 rebuilt，让页面拿到的地址和缓存一致（#63）。 */
function publishClientBundleRevs(ctx, packageNames) {
  if (!Array.isArray(packageNames) || packageNames.length === 0) return;
  let mods = null;
  try {
    mods = ctx?.get?.("clientModules", false);
  } catch {
    mods = null;
  }
  if (!mods || typeof mods.rebuilt !== "function") return;
  for (const id of packageNames) {
    try { mods.rebuilt(id); } catch { /* 这一包还没进注册表，下次快照会读到新文件 */ }
  }
}

/** Cordis 的 ctx 是 Proxy：未声明 inject 时点属性会抛 "cannot get property ... without inject"，所以两段都要包 try。 */
function permissionPresetsOf(ctx) {
  try {
    const direct = ctx?.permissionPresets;
    if (direct && typeof direct.set === "function") return direct;
  } catch {
    /* 未 inject 这项服务时，Cordis 代理会抛，不能让新会话的全开权限钉死失败。 */
  }
  try {
    const svc = ctx?.get?.("permissionPresets");
    if (svc && typeof svc.set === "function") return svc;
  } catch {
    /* 没有这项服务。 */
  }
  return null;
}

/**
 * 最近几个会话的权限档位。
 *
 * [2.3.0] 破甲的一个关键面是「这一轮会话到底有没有完全权限」。工具的 execute() 拿不到
 * invocation，定位不到"当前会话"，所以这里退一格：报最近创建的会话及其实际 preset，
 * 由读者自己对号。取不到就返回空数组，不猜。
 */
function recentSessionPresets(ctx, limit = 5) {
  const out = [];
  try {
    const store = ctx.get?.("sessions");
    const all = typeof store?.all === "function" ? store.all()
      : typeof store?.list === "function" ? store.list()
      : [];
    const svc = permissionPresetsOf(ctx);
    for (const session of (Array.isArray(all) ? all : []).slice(-limit)) {
      let preset = "";
      try {
        const state = typeof svc?.permissionState === "function" ? svc.permissionState(session) : null;
        preset = state?.preset || session?.header?.permissionPreset || "";
      } catch {
        preset = session?.header?.permissionPreset || "";
      }
      out.push({
        id: String(session?.id || session?.header?.id || ""),
        preset: preset || "unknown",
      });
    }
  } catch { /* 没有 sessions 服务时保持空 */ }
  return out;
}

function parentPermissionPreset(ctx, session) {
  const parentId = session?.header?.parentSession;
  if (!parentId || !ctx) return "";
  try {
    const registry = ctx.agents || ctx.get?.("agents");
    const parent = registry?.get?.(parentId);
    let parentSession = parent?.session;
    if (!parentSession) {
      const store = ctx.get?.("sessions");
      parentSession = typeof store?.get === "function" ? store.get(parentId) : null;
    }
    if (!parentSession) return "";
    const svc = permissionPresetsOf(ctx);
    const state = typeof svc?.permissionState === "function" ? svc.permissionState(parentSession) : null;
    return state?.preset || parentSession?.header?.permissionPreset || "";
  } catch {
    return "";
  }
}

function shouldKeepFreshFullAccess(session, svc) {
  const state = typeof svc.permissionState === "function" ? svc.permissionState(session) : null;
  const preset = state?.preset;
  if (preset === "danger-full-access" || preset === "auto" || preset === "custom") return false;
  const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
  const pins = Array.isArray(events) ? events.filter((event) => event?.type === "permission/preset") : [];
  if (pins.length > 1) return false;
  return preset == null || preset === "workspace-write" || preset === "read-only";
}

function upgradeFreshSessionAccess(ctx, session) {
  try {
    const svc = permissionPresetsOf(ctx);
    if (!svc) return;
    const inherited = parentPermissionPreset(ctx, session);
    if (inherited) {
      const state = typeof svc.permissionState === "function" ? svc.permissionState(session) : null;
      if (state?.preset !== inherited) svc.set(session, inherited);
      return;
    }
    if (!shouldKeepFreshFullAccess(session, svc)) return;
    svc.set(session, "danger-full-access");
  } catch (error) {
    console.warn("[dsh-purge] full-access pin:", error instanceof Error ? error.message : String(error));
  }
}

/** 空会话界面按部署默认显示完全权限；建会话时若钉成 workspace-write，发消息后芯片会掉下去。 */
function pinExistingSessionAccess(ctx) {
  try {
    const store = ctx.get?.("sessions");
    const all = typeof store?.all === "function" ? store.all()
      : typeof store?.list === "function" ? store.list()
      : [];
    for (const session of all || []) upgradeFreshSessionAccess(ctx, session);
  } catch { /* 注册表还没起来时等 session/created */ }
}

function installFreshFullAccess(ctx) {
  if (typeof ctx.on !== "function" || ctx.__dshPurgeFullPin) return;
  ctx.__dshPurgeFullPin = true;
  // ctx.effect:plugin dispose 时解绑 session/created,否则 handler 残留 + 热重载翻倍。
  ctx.effect(() => {
    let disposer = null;
    try { disposer = ctx.on("session/created", (session) => {
      queueMicrotask(() => upgradeFreshSessionAccess(ctx, session));
    }); } catch { /* ignore */ }
    queueMicrotask(() => pinExistingSessionAccess(ctx));
    return () => {
      try { if (typeof disposer === "function") disposer(); } catch { /* ignore */ }
      delete ctx.__dshPurgeFullPin;
    };
  });
}

function installCwdCapture(ctx) {
  if (!ctx || ctx.__dshPurgeCwdCapture) return;
  if (typeof ctx.on !== "function") return;
  ctx.__dshPurgeCwdCapture = true;
  const home = core.findDshHome();
  let lastWritten = "";
  const flush = (session) => {
    try {
      const cwd = String(session?.header?.cwd || "").trim();
      if (!cwd || !home || cwd === lastWritten) return;
      rules.writeLastCwd(home, cwd);
      lastWritten = cwd;
    } catch { /* ignore */ }
  };
  try {
    const store = ctx.get?.("sessions");
    const all = typeof store?.all === "function" ? store.all()
      : typeof store?.list === "function" ? store.list()
      : [];
    for (const session of all || []) flush(session);
  } catch { /* ignore */ }
  ctx.effect(() => {
    const disposers = [];
    try { disposers.push(ctx.on("session/created", flush)); } catch { /* ignore */ }
    try { disposers.push(ctx.on("session/event", (session) => flush(session))); } catch { /* ignore */ }
    return () => {
      for (const d of disposers) {
        try { if (typeof d === "function") d(); } catch { /* ignore */ }
      }
      delete ctx.__dshPurgeCwdCapture;
    };
  });
}

function installRewindDeriveFilter(ctx) {
  if (!ctx || ctx.__dshPurgeRewindDerive) return;
  ctx.__dshPurgeRewindDerive = true;
  const wrapOne = (session) => {
    try { rewind.wrapSessionDeriveMessages(session); } catch { /* ignore */ }
  };
  try {
    const store = ctx.get?.("sessions");
    const all = typeof store?.all === "function" ? store.all()
      : typeof store?.list === "function" ? store.list()
      : [];
    for (const session of all || []) wrapOne(session);
  } catch { /* ignore */ }
  ctx.effect(() => {
    let disposer = null;
    try { disposer = ctx.on("session/created", (session) => wrapOne(session)); } catch { /* ignore */ }
    return () => {
      try { if (typeof disposer === "function") disposer(); } catch { /* ignore */ }
      delete ctx.__dshPurgeRewindDerive;
    };
  });
}

/**
 * 把 install(ctx) 挂到 ctx.effect 作用域里，随插件卸载一起 dispose。
 * 没有 effect 作用域时退回裸调用；任何异常都吞掉，绝不阻断插件的其余安装。
 * 与 ZXEB 的 attachScopedEffect 同义，命名跟随本仓 install* 系列。
 */
function installScopedEffect(ctx, install) {
  const run = () => {
    try {
      return install(ctx);
    } catch {
      return () => {};
    }
  };
  try {
    if (typeof ctx.effect === "function") {
      ctx.effect(() => run());
      return;
    }
  } catch {
    /* 无 effect 作用域 */
  }
  run();
}

function installIdentityOverride(ctx, config = {}) {
  if (typeof ctx.on !== "function") return;
  installSubagentRoleCapture(ctx);
  // DSML 正文兜底：模型把工具调用写成 <DSML|invoke ...> 正文时，宿主收不到 tool-call 块，
  // 工具不执行、这一轮挂住。只在 provider/model 命中白名单、且本轮带工具时生效。
  // 默认关闭（config.dsmlGuard），打开代价是首字延迟——命中时要等整轮结束才下发首段。
  installScopedEffect(ctx, (c) => installNativeToolGuard(c, { enabled: config.dsmlGuard === true }));
  // installAssembleGuard 幂等:slot.rewrite 已挂的 prompt 对象只刷新 rewriteFn,
  // 不再 return 新 dispose。原实现每 400ms + 每 pre-step push 一个 noop closure 入 Set,
  // 2 小时 session 累积上万条。改为:只 track 首次真正挂上的 disposer。
  const wrapDisposers = new Set();
  const wrappedPrompts = new WeakSet();
  const trackDisposer = (d, prompt) => {
    if (typeof d !== "function") return d;
    if (prompt) {
      if (wrappedPrompts.has(prompt)) return d;
      wrappedPrompts.add(prompt);
    }
    wrapDisposers.add(d);
    return d;
  };
  const rewriteFn = (assembled, context) => {
    // [方案2] installAssembleGuard 走的也是这条路径,同样决策 full/anchor。
    const decision = shouldInjectAssembly(context);
    logAssembleDecision("rewriteFn", decision);
    return rewriteLiveAssembly(config, assembled, context, decision);
  };
  // interval 心跳每 400ms 调一次,正常稳态下所有参数不变 — 只在状态翻转或出错时写日志,
  // 避免每天上百万条 guard.wrap 把 7MB 日志刷爆、把真正事件淹没。
  let lastGuardSig = "";
  const wrapAssemble = (caller = "unknown") => {
    try {
      const prompt = ctx.systemPrompt;
      const d = installAssembleGuard(prompt, rewriteFn);
      const mounted = typeof d === "function";
      const tracked = trackDisposer(d, prompt);
      const sig = `${!!prompt}|${mounted}`;
      if (sig !== lastGuardSig) {
        purgeLog("guard.wrap", { caller, prompt: !!prompt, mounted });
        lastGuardSig = sig;
      }
      return tracked;
    } catch (e) {
      purgeLog("guard.wrap", { caller, err: String(e?.message || e) });
      lastGuardSig = "";
      return false;
    }
  };
  if (!ctx.__dshPurgeAssembleHook) {
    ctx.__dshPurgeAssembleHook = true;
    // cordis 不同版本的 waterfall 可能是 (assembly, context) 或 (assembly, context, next)：
    // 旧写法把 `next` 当函数直接取第 3 位，老宿主就拿到 context 当 next，await next() 立刻抛。
    // disposer 不进 wrapDisposers:ctx.effect cleanup 在 child scope 结束/预设切换都会触发,
    // 收集进去的话会被误解绑,之后再也挂不回来。cordis 真 dispose 时 listener 自己跟 ctx 释放。
    try {
      ctx.on("system-prompt/assemble", async (...args) => {
        const [assembly, context] = args;
        const next = args.length >= 3 ? args[args.length - 1] : null;
        // 入口即记录 — 看请求是否真的到达了我们的 handler;hasNext=false 时说明 cordis
        // 走的旧签名,下游 waterfall 全靠我们返回的 assembled。
        let eventsLen = 0;
        try { eventsLen = readSessionEvents(context?.agent?.session).length; } catch {}
        purgeLog("assemble.entry", {
          hasNext: typeof next === "function",
          sections: Array.isArray(assembly?.sections) ? assembly.sections.length : -1,
          events: eventsLen,
        });
        let assembled = assembly;
        if (typeof next === "function") {
          try {
            assembled = await next();
          } catch (err) {
            // 下游 waterfall 任一环节抛就会把整条 assemble 弄死,UI 卡住发不出去。
            // 吞掉改用上游装配兜底,inject 保底能挂上。
            try { console.warn("[dsh-purge] system-prompt/assemble waterfall rejected:", err?.message || err); } catch {}
            purgeLog("assemble.waterfall", { err: String(err?.message || err) });
            assembled = assembly;
          }
        }
        try {
          // [v10] 事件处理器开场主动 refresh:新对话首轮 hungCache 可能 null、
          // installAssembleGuard 可能还没包上 systemPrompt,这里强制把 pinned/磁盘读热,
          // 保证 readInjectFallback → refreshHungOperator 命中已 warm 的 cache 不走回空值路径。
          try { refreshHungOperator(core.findDshHome()); } catch { /* resolve 过程异常不阻塞 */ }
          const decision = shouldInjectAssembly(context);
          logAssembleDecision("event", decision);
          return rewriteLiveAssembly(config, assembled, context, decision);
        } catch (err) {
          try { console.warn("[dsh-purge] rewriteLiveAssembly failed:", err?.message || err); } catch {}
          purgeLog("assemble.rewriteFail", { err: String(err?.message || err) });
          return assembled;
        }
      }, { global: true, prepend: true });
    } catch { /* ctx.on 老版本签名异常,下次 apply 覆盖 */ }
  }
  // 切换预设会换掉 assemble。pre-step 瀑布在 assemble 之后才跑，第一次发送包不上。
  // 宿主在 assemble 之前调用这个函数，用的就是当前模式自己的 systemPrompt。
  const prepareAssemble = (loopCtx) => {
    try { refreshHungOperator(core.findDshHome()); } catch { /* 主目录还没有提示词 */ }
    // loopCtx 可能是宿主的 Proxy，访问 .systemPrompt 自身就会抛（代理层尚未注入服务）。
    let prompt = null;
    try { prompt = loopCtx && loopCtx.systemPrompt; } catch { prompt = null; }
    if (prompt) {
      try {
        trackDisposer(installAssembleGuard(prompt, rewriteFn), prompt);
      } catch { /* 这一层代理包不上时，下面再包插件自己的 */ }
    }
    try {
      const iso = (loopCtx && loopCtx.ctx) || loopCtx;
      if (iso && iso !== ctx) registerPromptSections(iso, config);
    } catch { /* 隔离层还没有 systemPrompt */ }
    wrapAssemble("prepareAssemble");
    return prompt || null;
  };
  globalThis.__dshPurgePrepareAssemble = prepareAssemble;
  const hungFn = installHungPromptGlobal();
  // complete:true 会在 waterfall 之后盖掉 sections；包住 assemble 返回值，每轮都补回注入。
  wrapAssemble("init");
  // guard 需要在每次 cordis 换 systemPrompt 代理时重挂（session 内切预设、subagent fork、
  // live-mount）。原本 20 秒后 clearInterval，之后换代理就包不上 → 第二轮 inject 走原生
  // assemble → 宿主按 token 预算裁剪 → 用户看到"只截取了部分"。installAssembleGuard 幂等
  // （wrappedPrompts WeakSet + 对象 identity 校验），400ms 持续跑到 ctx dispose 的 CPU 代价可忽略。
  // 400ms 回滚:2000ms 窗口 → 新对话第一次 assemble 可能跑在钩子挂上之前,inject 塌。
  // CPU 代价(幂等 wrap)相比"新对话失效"的用户感知,根本不值一提。
  const timer = setInterval(() => wrapAssemble("interval"), 400);
  if (typeof timer.unref === "function") timer.unref();
  // 下面三个 ctx.on 必须加 flag:installIdentityOverride 若被同一 ctx 二次 apply
  // (dispose 后重 mount / 热重载),listener 叠加会让 inject 跑 N 遍,也让 wrap 挂 N 层。
  if (!ctx.__dshPurgeSessionHook) {
    ctx.__dshPurgeSessionHook = true;
    try {
      ctx.on("session/created", () => {
        try { refreshHungOperator(core.findDshHome()); } catch { /* 主目录还没有提示词 */ }
        wrapAssemble("sessionCreated");
      });
    } catch { /* ignore */ }
  }
  if (!ctx.__dshPurgePresetHook) {
    ctx.__dshPurgePresetHook = true;
    try {
      ctx.on("agent-preset/selected", () => {
        try { refreshHungOperator(core.findDshHome()); } catch { /* 主目录还没有提示词 */ }
        wrapAssemble("presetSelected");
      }, { global: true });
    } catch { /* ignore */ }
  }
  if (!ctx.__dshPurgePreStepHook) {
    ctx.__dshPurgePreStepHook = true;
    try {
      ctx.on("agent/pre-step", (payload, next) => {
        wrapAssemble("preStep");
        return typeof next === "function" ? next() : payload;
      }, { global: true, prepend: true });
    } catch { /* ignore */ }
  }
  // 热重载/卸载时统一回收：轮询 timer、guard 代理层、暴露给 agent loop 的全局钩子，
  // 都在同一个 effect 里扫掉；避免下次 apply 再绑一层造成多次写入。
  try {
    ctx.effect(() => () => {
      clearInterval(timer);
      for (const d of wrapDisposers) {
        try { d(); } catch { /* ignore */ }
      }
      wrapDisposers.clear();
      // 清 flag,下次 apply 允许重新挂 listener;不然 ctx 复用时沉默无响应。
      delete ctx.__dshPurgeSessionHook;
      delete ctx.__dshPurgePresetHook;
      delete ctx.__dshPurgePreStepHook;
      // [v10] AssembleHook 也要清。原漏删,ctx 复用时新 apply 看到 flag=true 直接跳过
      // ctx.on("system-prompt/assemble", ...),cordis event listener 永远不装 → 新对话首轮
      // 完全依赖 400ms setInterval wrapAssemble 的 guard,时间窗没赶上就 inject 真空。
      delete ctx.__dshPurgeAssembleHook;
      // 新对话 / 热重载会先 dispose 再 apply。这里若删全局 hung，
      // 空窗里立刻发送 hang 读到空串，必须等下一次 apply 才恢复。
    });
  } catch { /* 无 effect 时靠 unref + 下次 apply 自覆盖 */ }
}

function shimNeedsPatch(state) {
  if (hostctl.currentSurface() === "desktop") return false;
  return (
    state.shim_cmd === "original" ||
    state.shim_ps1 === "original" ||
    state.shim_bin === "original"
  );
}

function currentSettleScope() {
  let sealed = false;
  try { sealed = core.desktopAsarStillSealed(); } catch { /* 非桌面或还没定位安装目录 */ }
  return { surface: hostctl.currentSurface(), sealed };
}

async function settleInstalledPatches(config, ctx, life) {
  if (life && !life.alive) return "skip:inactive";
  try { core.rememberUnpackedArchive(); } catch { /* 没有官方安装目录时不必记归档 */ }
  try {
    reapply.ensureInstalledRevSeed();
  } catch (e) {
    log(config, "seed installed-rev failed:", String(e && e.message ? e.message : e));
  }
  try {
    if (reapply.healEmptyAppliedStamp()) log(config, "healed empty applied stamp");
  } catch (e) {
    log(config, "heal applied stamp failed:", String(e && e.message ? e.message : e));
  }

  if (config.autoApplyOnStart !== true) {
    try {
      if (await reapply.patchesMatchInstallStrict() || await reapply.hostCleanEnoughToKeep()) {
        reapply.markPatchesApplied();
        log(config, "boot: host files left untouched; stamp kept");
        return "boot:host-untouched";
      }
    } catch { /* 没戳也没关系，等用户点应用 */ }
    log(config, "boot: skip host writes (Apply once)");
    return "skip:boot-no-host-write";
  }

  const scope = currentSettleScope();
  if (!(await reapply.patchesMatchInstallStrict())) {
    if (!settleMayReapply(scope)) {
      log(config, "sealed desktop: skip startup reapply (wait for Apply)");
      return "skip:sealed-wait-apply";
    }
    if (await reapply.hostCleanEnoughToKeep()) {
      reapply.markPatchesApplied();
      log(config, "host already clean; kept patches and refreshed stamp");
      return "already-clean";
    }
    if (officialUpdate.upgradeMarkerExists(process.execPath)) {
      const upgraded = await reapply.reapplyInstalled({ scheduleSwap: false, upgrade: true });
      if (life && !life.alive) return "skip:inactive";
      if (!upgraded.ok) {
        log(config, "official upgrade reapply failed:", upgraded.error || "");
        return "reapply-failed";
      }
      officialUpdate.clearUpgradeMarker(process.execPath);
      officialUpdate.clearStaleExtractedApps(process.execPath);
      if (!settleMayRestart(currentSettleScope()) || reapply.shouldSkipSettleRestart()) {
        if (upgraded.needsFullQuit) bootFullQuit = true;
        log(config, "official upgrade reapplied; skip settle restart");
        return "reapplied-no-restart";
      }
      reapply.markSettleRestart();
      log(config, "official upgrade reapplied; restarting onto the new build");
      // ctx 可能在 reapply.reapplyInstalled 的 await 中被 dispose；重启前再查一次。
      if (life && !life.alive) return "skip:inactive";
      try {
        hostctl.scheduleRestart(null, ctx, { openBrowser: false });
      } catch (e) {
        log(config, "restart after official upgrade failed:", String(e && e.message ? e.message : e));
        return "restart-failed";
      }
      return "restarting";
    }

    // 启动自愈只写盘，不 swap asar / 不杀进程，避免官方 Host Fiber._reload 撞 INACTIVE_EFFECT。
    const result = await reapply.reapplyInstalled({ scheduleSwap: false });
    if (life && !life.alive) return "skip:inactive";
    if (!result.ok) {
      log(config, "reapply failed:", result.error || "");
      return "reapply-failed";
    }
    // reapply 成功后强制保证非空戳，避免 clean 路径漏写又空转（#59/#60）。
    try { reapply.markPatchesApplied(); } catch { /* ignore */ }
    if (result.needsFullQuit) {
      bootFullQuit = true;
      log(config, "reapply wrote patches; official host needs a full quit");
      return "full-quit";
    }
    if (!settleMayRestart(currentSettleScope())) {
      log(config, "reapply wrote patches; desktop settle does not restart");
      return "reapplied-no-restart";
    }
    if (reapply.shouldSkipSettleRestart()) {
      log(config, "reapply wrote patches; skip settle restart (cooldown)");
      return "reapplied-no-restart";
    }
    // 已对齐则不必再重启；只在 stamp/宿主仍不一致时重启一次。
    if (await reapply.patchesMatchInstallStrict()) {
      log(config, "reapply wrote patches; already aligned, no restart");
      return "reapplied";
    }
    reapply.markSettleRestart();
    log(config, "reapply wrote patches; restarting");
    // reapplyInstalled 自带 await；重启前再查一次 life，避免对 disposed ctx 发起 scheduleRestart。
    if (life && !life.alive) return "skip:inactive";
    try {
      // web：自愈重启不弹浏览器，关窗后不应再被反复拉起新窗口（#59/#61）。
      hostctl.scheduleRestart(null, ctx, { openBrowser: false });
    } catch (e) {
      log(config, "restart after reapply failed:", String(e && e.message ? e.message : e));
      return "restart-failed";
    }
    return "restarting";
  }

  const applied = await autoApply(config);
  if (config.autoUpdateOnStart === true) {
    updater.autoUpdateIfNeeded()
      .then((r) => {
        // ctx 可能在 autoUpdate 等待网络的过程中被 dispose（热重载 / 卸载）。
        // 回调里再碰 ctx.scheduleRestart 会命中 INACTIVE_EFFECT。
        if (life && !life.alive) return;
        log(config, "auto-update:", JSON.stringify(r));
        if (r && r.needsFullQuit) bootFullQuit = true;
        if (r && r.restartAfter && settleMayRestart(currentSettleScope())) {
          if (life && !life.alive) return;
          try { hostctl.scheduleRestart(null, ctx, { openBrowser: false }); } catch (e) {
            console.warn("[dsh-purge] auto-update restart failed:", e);
          }
        }
      })
      .catch((e) => console.warn("[dsh-purge] auto-update error:", String(e)));
  }
  return applied;
}

async function autoApply(config) {
  try {
    core.applyRuntimeEnv();
    const sanitized = core.sanitizeDesktopCommandRuntimes();
    if (sanitized.length) log(config, "desktop runtime sanitized:", JSON.stringify(sanitized));

    core.refreshHooksDenySettings();
    if (core.getHooksDenySettings().hooksDenyBypass === false) {
      const restored = await core.restoreHookDenyForBases(core.enumeratePatchAiBases());
      if (restored.failed.length) {
        log(config, "hooks-deny restore leftover:", restored.failed.join(","));
      }
    }

    const state = await core.gatherState();
    if (!state.ai_base) {
      log(config, "skip auto-apply: plugin root not found");
      return "skip:plugin_root_not_found";
    }
    try {
      const flash = core.silenceCmdFlash(state.ai_base);
      log(config, "cmd-flash:", JSON.stringify(flash));
      if (!flash.ok) log(config, "cmd-flash incomplete:", flash.entry);
    } catch (e) {
      log(config, "cmd-flash failed:", String(e));
    }

    if (state.patches_pending === 0) {
      if (config.autoApplyOnStart && shimNeedsPatch(state)) {
        await core.patchAllShims();
        core.silenceCmdFlash(state.ai_base);
        log(config, "auto-apply: patches clean, shim refreshed");
        return "already_clean:shim_patched";
      }
      log(config, "auto-apply: already clean");
      return "already_clean";
    }
    if (!config.autoApplyOnStart) {
      log(config, "auto-apply disabled");
      return "disabled";
    }
    const autoMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, { preserveClientBundles: true });
    await core.patchAllShims();
    const report = autoMulti.report;
    const flash = core.silenceCmdFlash(autoMulti.hosts[0]?.aiBase || state.ai_base);
    const applied = report.filter((r) => r.status === "applied").length;
    log(config, `auto-apply done: ${applied} applied; cmd-flash=${flash.entry} ok=${flash.ok}`);
    return flash.ok ? `applied:${applied}` : `applied:${applied}:cmd_flash_incomplete`;
  } catch (e) {
    console.warn("[dsh-purge] auto-apply error:", String(e));
    return `error:${e}`;
  }
}

/** 应用之后的那一次重启。密封包退出再打开，不再干等用户自己退出。 */
function scheduleApplyRestart(shouldRestart, ctx = null) {
  if (!shouldRestart) return { restarting: false };
  if (core.desktopAsarStillSealed()) {
    // 透传 ctx 给核心层,让密封包重启也能走 PowerShell 立即 kill Electron + requestRestart
    // 双保险路径,不再弹"host stopped"崩溃对话框 (#64)。
    const planned = core.restartSealedDesktopIfNeeded({ ctx });
    return {
      ...(planned || {}),
      restarting: Boolean(planned && (planned.restarting || planned.asarSwap)),
    };
  }
  try {
    const planned = hostctl.scheduleRestart(null, ctx);
    if (planned && (planned.restarting === false || planned.clean === false)) return planned;
    return planned || { restarting: true };
  } catch (error) {
    return { restarting: false, error: String(error && error.message ? error.message : error) };
  }
}

async function handlePurgeCommand(rawInput, config, ctx = null) {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "status").toLowerCase();

  switch (sub) {
    case "status":
    case "s": {
      const state = await core.gatherState();
      return { kind: "success", text: renderStatus(state) };
    }
    case "apply":
    case "a": {
      core.applyRuntimeEnv();
      core.clearDesktopLocateCache();
      const home = core.pinDshHome();
      const scrubbed = core.sanitizeDesktopCommandRuntimes();
      const state = await core.gatherState();
      if (home) state.dsh_home = home;
      let located;
      try {
        located = await core.resolveOfficialAiBase(state.ai_base, { forApply: true });
      } catch (e) {
        return { kind: "error", text: String(e && e.message ? e.message : e) };
      }
      if (!located.aiBase) return { kind: "error", text: core.missingAiBaseMessage() };
      state.ai_base = located.aiBase;
      if (located.extracted && located.handoff?.archive) {
        core.writeUnpackedAsarStamp(located.handoff.archive);
      }
      const blocked = rejectIfNeedPrompt(state.dsh_home);
      if (blocked) return { kind: "error", text: blocked.error };
      const applyMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
        preserveClientBundles: false,
        forApply: true,
      });
      const report = applyMulti.report;
      const shimResult = await core.patchAllShims();
      const flash = core.silenceCmdFlash(applyMulti.hosts[0]?.aiBase || state.ai_base);
      const lines = [];
      for (const h of applyMulti.hosts) lines.push(`  宿主 / host → ${h.aiBase}`);
      lines.push(...report.map((r) => {
        const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : `✗ ${r.status}`;
        return `  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`;
      }));
      lines.push("", "shim:");
      for (const [dir, st] of Object.entries(shimResult)) {
        lines.push(`  · ${dir} → ${typeof st === "object" ? JSON.stringify(st) : st}`);
      }
      lines.push(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
      if (scrubbed.length) {
        lines.push("", "Desktop in-bin .bak scrub:");
        for (const row of scrubbed) lines.push(`  ✓ ${row.dir} → ${row.cleaned.join(", ")}`);
      }
      lines.push("Desktop: host-commands 密封目录只清理不注入；bak 禁止写进 bin（issue #9）。");
      const summary = core.summarizeApplyReport(report);
      const hostWritten = core.allPatchHostsWritten(applyMulti.hosts) || core.hostCleanMarkersPresent(state.ai_base);
      const hookDenyRestoreFailed = (applyMulti.hookDenyRestoreFailed || []).length > 0;
      const complete = summary.failed.length === 0 && flash.ok === true && hostWritten && !hookDenyRestoreFailed;
      const promptReady = summary.failed.length > 0 && summary.failed.every((item) => item.status === "pattern_not_found");
      const shouldRestart = applyShouldRestart({
        complete: complete || (promptReady && hostWritten),
        sealed: core.desktopAsarStillSealed(),
        appliedCount: summary.applied,
        promptReady: promptReady && hostWritten,
      });
      if (shouldRestart) reapply.markSettleRestart();
      try { core.seedPromptInjectAtBoot(state.dsh_home); } catch { /* 主目录尚未就绪 */ }
      try { refreshHungOperator(state.dsh_home); } catch { /* ignore */ }
      const planned = scheduleApplyRestart(shouldRestart, ctx);
      if (planned && planned.clean === false) {
        lines.push("", "清洗没有写进当前宿主，已取消重启。");
      } else if (planned && planned.restarting === false && planned.error) {
        lines.push("", String(planned.error));
      } else if (shouldRestart && planned && planned.restarting !== false) {
        lines.push("", "正在重启。");
      } else if (!complete) {
        lines.push("", "清洗没有完成，没有重启。");
      } else {
        lines.push("", "补丁已经在宿主里，不再重启。");
      }
      return { kind: "success", text: lines.join("\n") };
    }
    case "revert":
    case "r": {
      const state = await core.gatherState();
      const lines = [];
      if (state.ai_base) {
        const { reverted, errors } = await core.revertAll(state.ai_base);
        lines.push(...reverted.map((p) => `  ✓ 已还原 / Reverted ${p}`));
        for (const [p, e] of errors) lines.push(`  ⚠ 还原失败 ${p}: ${e}`);
        if (reverted.length === 0) lines.push("  - 没有补丁备份可还原 / no patch backup");
      }
      const shimRevert = await core.revertAllShims();
      for (const [dir, st] of Object.entries(shimRevert)) {
        lines.push(`  shim ${dir}: ${typeof st === "object" ? JSON.stringify(st) : st}`);
      }
      lines.push("", "回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
      lines.push("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
      return { kind: "success", text: lines.join("\n") };
    }
    case "uninstall":
    case "remove": {
      const result = await uninstaller.uninstallPurge();
      const lines = [];
      if (result.applied) lines.push("已检测到补丁，已还原回原版。");
      else lines.push("未检测到已应用补丁，仍会清除插件文件。");
      if (result.patches) {
        lines.push(`  还原文件 ${result.patches.reverted?.length || 0} 个`);
      }
      if (result.override?.removed) lines.push(`  已删除 ${result.override.path}`);
      if (result.stripped?.length) lines.push(`  已从 profile 移除: ${result.stripped.join(", ")}`);
      if (result.errors?.length) {
        for (const e of result.errors) lines.push(`  ⚠ ${e}`);
      }
      lines.push("", "请重启 dsh。重启后插件不再加载。");
      return { kind: result.ok ? "success" : "error", text: lines.join("\n") };
    }
    case "edit":
    case "e": {
      const state = await core.gatherState();
      let r = core.editOverride(state.dsh_home);
      let created = false;
      if (!r.ok && r.needCreate) {
        await core.installOverride(state.dsh_home, true);
        r = core.editOverride(state.dsh_home);
        created = true;
      }
      // 旧实现：r.ok 为 false 时仍然返回 kind:"success"，用户看到"已打开"但进程根本没起来。
      if (!r.ok) {
        return { kind: "error", text: r.error || "打开编辑器失败" };
      }
      return {
        kind: "success",
        text: created
          ? `已创建默认注入文件并打开编辑器：${r.path}\n重启 dsh 生效。`
          : `已打开 ${r.editor} 编辑注入文件：${r.path}\n编辑完成后重启 dsh 生效。`,
      };
    }
    case "help":
    case "h":
    default:
      return {
        kind: "success",
        text: "dsh-purge 命令：\n" +
          "  /purge status     显示状态\n" +
          "  /purge apply      应用全部清洗（提示词+代码+shim+override）\n" +
          "  /purge revert     回滚还原\n" +
          "  /purge uninstall  卸载插件（已应用则先还原）\n" +
          "  /purge edit       编辑注入文件 prompt-inject.md\n" +
          "  /purge help       显示帮助\n" +
          "规则集切换见 /rules（list | use <id> | create | delete | reset）\n" +
          "官方 Skill 安装见 /skills（list | import <路径> | create <id> [说明] | delete <id>）\n" +
          "提示词快照见 /prompt（list | save <名字> | use <名字> | delete <名字>）\n" +
          "会话导出 /export，会话统计 /stats\n" +
          "全破自检 /audit（核对门禁/外挂/演练台/提示词/hooks 是否全开）",
      };
  }
}

function renderRulesStatus(st) {
  const out = [];
  out.push("规则集 / Rule Sets");
  out.push(`  存储目录 / store  ${st.rules_dir}`);
  const targetLine = st.active
    ? `${st.agents_path} (${st.active_target})`
    : "(无激活)";
  out.push(`  目标文件 / target ${targetLine} — exists=${st.agents_exists}, synced=${st.agents_synced}`);
  out.push("");
  if (st.rules.length === 0) {
    out.push("  (暂无规则 / no rules — 用 /rules create <id> 或设置页新建)");
  }
  for (const r of st.rules) {
    const isActive = r.id === st.active;
    const label = r.name !== r.id ? `${r.name} (${r.id})` : r.id;
    out.push(`  ${isActive ? "▶" : "·"} ${label}${isActive ? " ★ 当前" : ""} [${r.target}] (${rules.formatSize(r.size)})`);
  }
  return out.join("\n");
}

async function handleRulesCommand(rawInput) {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "list").toLowerCase();
  const dshHome = core.findDshHome();

  switch (sub) {
    case "list":
    case "ls":
    case "s":
      return { kind: "success", text: renderRulesStatus(await rules.rulesStatus(dshHome)) };
    case "use":
    case "activate":
    case "u": {
      const id = args[1];
      if (!id) return { kind: "error", text: "用法: /rules use <id>" };
      try {
        const meta = await rules.activateRule(dshHome, id);
        refreshHungOperator(dshHome);
        return {
          kind: "success",
          text: `✓ 已激活规则 ${meta.name}（${id}）→ 写入 ${rules.targetPath(dshHome, meta.target)}，并注入 systemPrompt。新会话生效。`,
        };
      } catch (e) {
        return { kind: "error", text: `激活失败: ${e.message}` };
      }
    }
    case "create":
    case "new":
    case "c": {
      const id = args[1];
      if (!id) return { kind: "error", text: "用法: /rules create <id> [别名] [AGENTS.md|CLAUDE.md]" };
      const name = args[2] || id;
      const target = args[3] || "AGENTS.md";
      if (!rules.validTarget(target)) {
        return { kind: "error", text: `无效目标: ${target}（只能是 AGENTS.md 或 CLAUDE.md）` };
      }
      try {
        await rules.saveRule(dshHome, id, "", { name, target });
        return {
          kind: "success",
          text: `✓ 已创建规则 ${name}（${id} → ${target}）。在设置页「规则设定」编辑内容后保存。`,
        };
      } catch (e) {
        return { kind: "error", text: `创建失败: ${e.message}` };
      }
    }
    case "delete":
    case "rm":
    case "d": {
      const id = args[1];
      if (!id) return { kind: "error", text: "用法: /rules delete <id>" };
      try {
        await rules.deleteRule(dshHome, id);
        refreshHungOperator(dshHome);
        return { kind: "success", text: `✓ 已删除规则 ${id}。` };
      } catch (e) {
        return { kind: "error", text: `删除失败: ${e.message}` };
      }
    }
    case "reset":
    case "restore":
    case "还原": {
      try {
        const r = await rules.resetToOriginal(dshHome);
        refreshHungOperator(dshHome);
        const lines = [];
        if (r.removed.length > 0) lines.push(`✓ 已删除插件写入的目标文件: ${r.removed.join(", ")}`);
        if (r.skipped.length > 0) {
          lines.push(`⚠ 跳过（文件内容与规则不一致，可能被手动修改）: ${r.skipped.join(", ")}`);
        }
        lines.push("已清空激活状态。规则库内容保留，随时可重新激活。现在回到出厂状态：无全局指令。");
        return { kind: "success", text: lines.join("\n") };
      } catch (e) {
        return { kind: "error", text: `还原失败: ${e.message}` };
      }
    }
    case "help":
    case "h":
    default:
      return {
        kind: "success",
        text: "规则集命令：\n" +
          "  /rules list                         列出所有规则\n" +
          "  /rules use <id>                     激活规则（写入 AGENTS.md/CLAUDE.md，并注入 systemPrompt）\n" +
          "  /rules create <id> [别名] [目标]     新建规则\n" +
          "  /rules delete <id>                  删除规则\n" +
          "  /rules reset                        还原原始状态\n" +
          "  /rules help                         显示帮助",
      };
  }
}

function renderSkillsStatus(st) {
  const out = [];
  out.push("官方用户 Skill / $DSH_HOME/skills");
  out.push(`  ${st.skills_dir}`);
  out.push("  插件只安装目录。调用走官方：任务对上 description/whenToUse 时模型调 skill 工具；聊天输入 /名称 立即加载。");
  out.push("  正文里写「激活」不会触发。官方认 name、description、whenToUse、disable-model-invocation、user-invocable。");
  out.push("");
  if (!st.skills.length) {
    out.push("  (暂无用户 Skill — 用 /skills import <压缩包或文件夹> 或设置页导入)");
    return out.join("\n");
  }
  for (const item of st.skills) {
    const mark = item.valid ? "·" : "!";
    const desc = item.description || "(无说明)";
    const how = item.valid
      ? [
        item.userInvocable ? `/${item.id}` : "不可 /名称",
        item.modelInvocable ? "模型可调" : "模型不可调",
      ].join(" · ")
      : "";
    out.push(`  ${mark} ${item.id}  ${desc}  (${skills.formatSize(item.size)})`);
    if (how) out.push(`      ${how}`);
    if (!item.valid && item.error) out.push(`      ${item.error}`);
  }
  return out.join("\n");
}

async function handleSkillsCommand(rawInput) {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "list").toLowerCase();
  const dshHome = core.findDshHome();

  switch (sub) {
    case "list":
    case "ls":
    case "s":
      return { kind: "success", text: renderSkillsStatus(await skills.skillsStatus(dshHome)) };
    case "create":
    case "new":
    case "c": {
      const id = args[1];
      if (!id) return { kind: "error", text: "用法: /skills create <id> [说明]" };
      if (!skills.validSkillName(id)) {
        return { kind: "error", text: "id 必须是 kebab-case，例如 code-review" };
      }
      const description = args.slice(2).join(" ").trim() || id;
      try {
        const saved = skills.toPublicSkill(dshHome, await skills.saveSkill(dshHome, id, "", description));
        return {
          kind: "success",
          text: `✓ 已写入官方目录 ${saved.path}\n新会话会进官方 Skill 目录；任务对上或输入 /${id} 时由官方加载。`,
        };
      } catch (e) {
        return { kind: "error", text: `安装失败: ${e.message}` };
      }
    }
    case "import":
    case "i": {
      const src = args.slice(1).join(" ").trim();
      if (!src) return { kind: "error", text: "用法: /skills import <压缩包或文件夹>" };
      try {
        const packed = await skills.importFromPath(dshHome, src);
        const names = packed.imported.map((item) => item.id).join(", ");
        return { kind: "success", text: `✓ 已导入到官方 $DSH_HOME/skills：${names}` };
      } catch (e) {
        return { kind: "error", text: `导入失败: ${e.message}` };
      }
    }
    case "delete":
    case "rm":
    case "d": {
      const id = args[1];
      if (!id) return { kind: "error", text: "用法: /skills delete <id>" };
      try {
        const removed = skills.toPublicSkill(dshHome, await skills.deleteSkill(dshHome, id));
        return {
          kind: "success",
          text: `✓ 已从官方目录删除 ${id}${removed.backup ? `\n备份：${removed.backup}` : ""}`,
        };
      } catch (e) {
        return { kind: "error", text: `删除失败: ${e.message}` };
      }
    }
    case "help":
    case "h":
    default:
      return {
        kind: "success",
        text: "官方 Skill 安装：\n" +
          "  /skills list                 列出 $DSH_HOME/skills\n" +
          "  /skills create <id> [说明]   写入 <id>/SKILL.md\n" +
          "  /skills import <路径>        导入压缩包或文件夹到官方目录\n" +
          "  /skills delete <id>          删除该目录（官方会从目录拿掉）\n" +
          "  也可自己删 $DSH_HOME/skills/<id>\n" +
          "  调用：聊天输入 /<id>，或让模型按 description 调 skill 工具\n" +
          "  不注入 systemPrompt，不替代提示词",
      };
  }
}

async function handlePromptCommand(rawInput) {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sub = (args[0] || "list").toLowerCase();
  const dshHome = core.findDshHome();

  switch (sub) {
    case "list":
    case "ls":
      return { kind: "success", text: promptSnapshots.renderSnapshotStatus(await promptSnapshots.snapshotStatus(dshHome)) };
    case "save":
    case "snap":
    case "s": {
      const name = args[1];
      if (!name) return { kind: "error", text: "用法: /prompt save <名字>" };
      try {
        const saved = await promptSnapshots.saveSnapshot(dshHome, name);
        return {
          kind: "success",
          text: `✓ 已保存当前提示词为快照 ${saved.name}（${rules.formatSize(saved.size)}）\n恢复：/prompt use ${saved.name}`,
        };
      } catch (e) {
        return { kind: "error", text: `保存失败: ${e.message}` };
      }
    }
    case "use":
    case "restore":
    case "u": {
      const name = args[1];
      if (!name) return { kind: "error", text: "用法: /prompt use <名字>" };
      try {
        // 恢复前先自动备份当前 prompt-inject.md，防误覆盖
        let backupNote = "";
        try {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const bk = await promptSnapshots.saveSnapshot(dshHome, `autobak-${stamp}`);
          backupNote = `\n（已自动备份当前提示词为快照 ${bk.name}）`;
        } catch { /* 备份失败不阻塞恢复 */ }
        const used = await promptSnapshots.useSnapshot(dshHome, name);
        refreshHungOperator(dshHome);
        return {
          kind: "success",
          text: `✓ 已恢复快照 ${used.name} → prompt-inject.md\n新会话生效。${backupNote}`,
        };
      } catch (e) {
        return { kind: "error", text: `恢复失败: ${e.message}` };
      }
    }
    case "export":
    case "exp": {
      const name = args[1];
      const target = args.slice(2).join(" ").trim();
      if (!name || !target) return { kind: "error", text: "用法: /prompt export <名字> <目标文件路径>" };
      try {
        const r = await promptSnapshots.exportSnapshotToFile(dshHome, name, target);
        return { kind: "success", text: `✓ 已导出快照 ${r.name} → ${r.target}（${rules.formatSize(r.size)}）` };
      } catch (e) {
        return { kind: "error", text: `导出失败: ${e.message}` };
      }
    }
    case "import":
    case "imp": {
      const name = args[1];
      const src = args.slice(2).join(" ").trim();
      if (!name || !src) return { kind: "error", text: "用法: /prompt import <名字> <源文件路径>" };
      try {
        const r = await promptSnapshots.importSnapshotFromFile(dshHome, name, src);
        return { kind: "success", text: `✓ 已从 ${r.source} 导入快照 ${r.name}（${rules.formatSize(r.size)}）` };
      } catch (e) {
        return { kind: "error", text: `导入失败: ${e.message}` };
      }
    }
    case "delete":
    case "rm":
    case "d": {
      const name = args[1];
      if (!name) return { kind: "error", text: "用法: /prompt delete <名字>" };
      try {
        const removed = await promptSnapshots.deleteSnapshot(dshHome, name);
        return { kind: "success", text: `✓ 已删除快照 ${removed.name}` };
      } catch (e) {
        return { kind: "error", text: `删除失败: ${e.message}` };
      }
    }
    case "help":
    case "h":
    default:
      return {
        kind: "success",
        text: "提示词快照 / Prompt Snapshots：\n" +
          "  /prompt list                    列出全部快照\n" +
          "  /prompt save <名字>             把当前 prompt-inject.md 存为快照\n" +
          "  /prompt use <名字>              恢复快照到 prompt-inject.md（自动备份当前，新会话生效）\n" +
          "  /prompt export <名字> <路径>    导出快照到任意文件\n" +
          "  /prompt import <名字> <路径>    从文件导入为快照\n" +
          "  /prompt delete <名字>           删除快照\n" +
          "  /prompt help                    显示帮助",
      };
  }
}

async function handleExportCommand(rawInput, ctx, fallbackSessionId = "") {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sessionId = args[0] || fallbackSessionId || "";
  const filePath = args.slice(1).join(" ").trim();
  try {
    const result = await sessionTools.exportSessionToFile(ctx, sessionId, filePath);
    return {
      kind: "success",
      text: `✓ 已导出会话到 ${result.path}\n${rules.formatSize(result.bytes)} · ${result.lines} 行`,
    };
  } catch (e) {
    return { kind: "error", text: `导出失败: ${e.message}` };
  }
}

async function handleStatsCommand(rawInput, ctx, fallbackSessionId = "") {
  const args = (rawInput || "").trim().split(/\s+/).filter(Boolean);
  const sessionId = args[0] || fallbackSessionId || "";
  try {
    const stats = await sessionTools.sessionStats(ctx, sessionId);
    return { kind: "success", text: sessionTools.renderSessionStats(stats) };
  } catch (e) {
    return { kind: "error", text: `统计失败: ${e.message}` };
  }
}

// ── 破甲状态投影 ──────────────────────────────────────────────────────────
// 监听助手回复，用 armor-scorer 判定有没有夹带拒绝，结果写进 sessionProjections，
// 由 client.js 的徽章读出来显示。纯观测，不干预任何行为。

function armorTextOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

const ARMOR_IDLE = Object.freeze({
  running: false,
  verdict: null,
  words: [],
  refusal: [],
  fallback: [],
  windowLen: 0,
});

function armorProjectionApply(state, event) {
  if (!event || typeof event !== "object") return state;
  if (event.type === "user/message") {
    return { ...ARMOR_IDLE, running: true };
  }
  if (event.type === "assistant/message") {
    const text = armorTextOf(event?.data?.message?.content);
    if (!text.trim()) return state;
    let scored;
    try {
      scored = armorScore(text);
    } catch {
      return state;
    }
    return {
      running: false,
      verdict: scored.verdict,
      words: scored.words,
      refusal: scored.refusal,
      fallback: scored.fallback,
      windowLen: scored.windowLen,
    };
  }
  return state;
}

function installArmorProjection(ctx) {
  // 宿主在装配投影时直接调 viewSchema.parse(...)，所以它必须是有 parse 的 schema，
  // 不能是普通对象（否则 SessionQueryError: def.wire.viewSchema.parse is not a function，
  // 会让所有会话的 resume 失败）。
  const passthroughSchema = { parse: (value) => value };
  const viewFields = ["running", "verdict", "words", "refusal", "fallback", "windowLen"];
  const def = {
    key: "dsh-purge-armor",
    stateVersion: 1,
    stateSchema: passthroughSchema,
    view: passthroughSchema,
    init: () => ({ ...ARMOR_IDLE }),
    apply: armorProjectionApply,
    wire: {
      viewSchema: passthroughSchema,
      view: (state) => {
        // 只输出已知字段，避免把内部结构泄给客户端
        const out = {};
        for (const k of viewFields) out[k] = state?.[k];
        return out;
      },
      summary: "破甲状态：上一轮回复有没有夹带拒绝",
    },
  };
  const attach = (projections) => {
    if (!projections || typeof projections.register !== "function") return;
    let ret;
    try {
      ret = projections.register(def);
    } catch {
      return;
    }
    // register() 返回 Object.assign(dispose, { then })——对象本身可调用，
    // 同时也是 thenable（acquire 失败时能 catch 到）。两种形态都处理。
    if (typeof ret === "function") {
      try {
        ctx.effect(() => () => {
          try { ret(); } catch { /* 卸载时忽略 */ }
        });
      } catch { /* 无 effect 时不注册清理 */ }
      // 走一遍 then 让内部 ready.catch 被观察到，避免 unhandled rejection
      try {
        if (typeof ret.then === "function") ret.then(() => {}, () => {});
      } catch { /* ignore */ }
    }
  };

  // 首选直连属性（宿主把服务挂在 ctx 上），退回 ctx.get
  let direct;
  try {
    direct = ctx.sessionProjections;
  } catch {
    direct = undefined;
  }
  if (!direct && typeof ctx.get === "function") {
    try { direct = ctx.get("sessionProjections"); } catch { direct = undefined; }
  }
  if (direct) {
    attach(direct);
    return;
  }
  // 兜底：动态注入
  if (typeof ctx.inject === "function") {
    try {
      ctx.inject(["sessionProjections"], (inner) => {
        let p;
        try { p = inner.sessionProjections; } catch { p = undefined; }
        if (!p && inner && typeof inner.get === "function") {
          try { p = inner.get("sessionProjections"); } catch { p = undefined; }
        }
        attach(p);
      });
    } catch { /* 宿主没有投影服务时静默跳过 */ }
  }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  if (!cfg.enabled) {
    purgeLog("boot", { enabled: false });
    try { clearOwnedSelectedDefault({ ctx, dshHome: core.findDshHome() }); } catch { /* 停用不被清默认挡住 */ }
    try { removeStaleAgentPresetDir(core.findDshHome(), "redteam"); } catch { /* ignore */ }
    return;
  }
  cancelClearOwnedSelectedDefault();
  try {
    ctx.effect(() => () => {
      try { scheduleClearOwnedSelectedDefault({ ctx, dshHome: core.findDshHome() }); } catch { /* 停用不被清默认挡住 */ }
    });
  } catch { /* 无 effect 时靠 uninstall / enabled:false 清 */ }
  purgeLog("boot", {
    enabled: true,
    surface: hostctl.currentSurface(),
    stripMnemon: cfg.stripMnemon !== false,
    cap: cfg.capabilityProtocol !== false,
  });
  core.setHooksDenyConfigValue(cfg.hooksDenyBypass);
  core.refreshHooksDenySettings();
  try { installArmorProjection(ctx); } catch { /* 投影装不上不影响主功能 */ }
  try {
    const home = core.pinDshHome() || core.findDshHome();
    purgeLog("home", { home: home || "(none)" });
    try {
      if (home) {
        const flag = path.join(home, ".hung-disabled");
        if (fs.existsSync(flag)) {
          fs.unlinkSync(flag);
          purgeLog("hung-disabled", { removed: flag });
        }
      }
    } catch (e) { purgeLog("hung-disabled", { err: String(e?.message || e) }); }
    installHungPromptGlobal();
    // Apply→cleanup→restart 成功后，默认把加密提示词 seed 进 prompt-inject.md。
    // 用户已经改过的文件不动；只有「没有」或「仍是空文件」时才补写。
    try {
      const seed = core.seedPromptInjectAtBoot(home);
      log(cfg, "seed prompt-inject:", seed?.action || "noop", seed?.reason || "");
    } catch (e) {
      console.warn("[dsh-purge] seed prompt-inject failed:", String(e && e.message ? e.message : e));
    }
    refreshHungOperator(home);
  } catch { /* 主目录还没有时，组装会再挂内置默认 */ }
  // 启动不写宿主包。补丁 / bak / client.js / runtime 只在点「应用」时写一次。
  const life = watchContextLife(ctx);
  if (!life.alive) {
    console.warn("[dsh-purge] skip apply: inactive context");
    return;
  }
  log(cfg, "plugin enabled");
  try {
    const home = core.pinDshHome() || core.findDshHome();
    const healed = ensureAllProfileInstall(home);
    for (const item of healed) {
      if (item.insert?.wrote || item.bundles?.wrote) {
        log(cfg, "profile heal:", item.dir, item.insert?.wrote ? "insert" : "", item.bundles?.wrote ? "bundles" : "");
      }
    }
  } catch { /* 自愈失败不挡主入口 */ }
  core.applyRuntimeEnv();
  try {
    const home = core.pinDshHome() || core.findDshHome();
    refreshHungOperator(home);
  } catch { /* 主目录还没有时，组装会再挂内置默认 */ }

  const settleTimer = setTimeout(() => {
    if (!life.alive) {
      log(cfg, "settle skipped: inactive context");
      return;
    }
    settleInstalledPatches(cfg, ctx, life)
      .then((r) => log(cfg, "settle:", r))
      .catch((e) => {
        if (isInactiveContextError(e)) {
          log(cfg, "settle skipped: inactive context");
          return;
        }
        console.warn("[dsh-purge] settle error:", String(e));
      });
    rules.ensureInitialState(core.findDshHome())
      .then((r) => log(cfg, "rules init:", JSON.stringify(r)))
      .catch((e) => console.warn("[dsh-purge] rules init error:", String(e)));
  }, settleDelayMs(hostctl.currentSurface()));
  try {
    ctx.effect(() => () => clearTimeout(settleTimer));
  } catch (e) {
    if (isInactiveContextError(e)) {
      clearTimeout(settleTimer);
      console.warn("[dsh-purge] skip apply: inactive context");
      return;
    }
    throw e;
  }

  try {
    applyHostHooks(ctx, cfg);
  } catch (e) {
    if (isInactiveContextError(e)) {
      console.warn("[dsh-purge] skip apply: inactive context");
      return;
    }
    throw e;
  }
}

function isDuplicateCommandError(error) {
  return /is already registered|already registered/i.test(String(error && error.message || error));
}

/** 逐命令注册：撞名只丢那一条，可退到备用名（#162）。
 *  v2.2.1：非撞名错误也只 warn 不抛 —— 命令注册失败绝不能把后面的 HTTP 路由注册带塌。 */
function tryRegisterCommand(commands, spec, fallbacks = []) {
  const names = [spec.name, ...fallbacks];
  for (const name of names) {
    try {
      commands.register({ ...spec, name });
      if (name !== spec.name) {
        console.warn(`[dsh-purge] /${spec.name} taken, registered /${name}`);
      }
      return name;
    } catch (error) {
      if (isDuplicateCommandError(error)) continue;
      // 非撞名错误（保留字、宿主校验等）：放弃这条命令，但不影响其它注册项和 HTTP 路由
      console.warn(`[dsh-purge] /${spec.name} register failed:`, error && error.message ? error.message : error);
      return null;
    }
  }
  console.warn(`[dsh-purge] skip /${spec.name}: already registered`);
  return null;
}

function applyHostHooks(ctx, cfg) {
  // v2.2.1：HTTP 路由必须最先注册。
  // 旧顺序把 installWebServer 放在函数最后 —— 前面任何一条 hook / 命令 / 工具注册抛错，
  // 面板就成了 404/405（路由根本没挂上）。现在先挂路由，再挂其余钩子。
  installWebServer(ctx, cfg);
  try {
    const home = core.pinDshHome() || core.findDshHome();
    refreshHungOperator(home);
  } catch { /* 主目录尚未就绪 */ }
  // v2.2.1：钩子安装整体容错。任一钩子抛错不能连带跳过后面的命令/工具注册。
  try {
    installIdentityOverride(ctx, cfg);
    installRegionGate(ctx);
    installFreshFullAccess(ctx);
    installRewindDeriveFilter(ctx);
    installCwdCapture(ctx);
    installMnemonMessageStrip(ctx, cfg);
    registerPromptSections(ctx, cfg);
  } catch (e) {
    console.warn("[dsh-purge] hook install failed:", e && e.message ? e.message : e);
  }

  // 本次 apply 作用域内的 continue-retry 状态；旧 ctx dispose 会把这些闭包一并带走。
  const continuePluginCfg = cfg;
  const savedContinueSettings = continueRetry.loadSettings(core.findDshHome());
  const continueRuntime = continueRetry.installContinueRetry(ctx, {
    getConfig: () => continueRetry.mergeConfig(continuePluginCfg, savedContinueSettings),
  });
  try {
    ctx.effect(() => () => {
      try { continueRuntime?.dispose?.(); } catch { /* ignore */ }
    });
  } catch { /* 无 effect 时靠 cordis scope 自己回收 */ }

  // 拒绝重试：默认关闭。检测到最后一条 assistant 输出是推脱时，自动追一句 nudge。
  // 走和自动续同一条路（agent.followup），所以用户会看到多一轮，但不用手动重问。
  const refusalHome = core.findDshHome();
  const savedRefusalSettings = refusalRetry.loadSettings(refusalHome);
  const refusalRuntime = refusalRetry.installRefusalRetry(ctx, {
    getConfig: () => refusalRetry.mergeConfig(cfg, savedRefusalSettings),
    dshHome: refusalHome,
    onRetry: (info) => console.log("[dsh-purge] refusal-retry:", JSON.stringify(info)),
  });
  try {
    ctx.effect(() => () => {
      try { refusalRuntime?.dispose?.(); } catch { /* ignore */ }
    });
  } catch { /* 无 effect 时靠 cordis scope 自己回收 */ }

  const commands = ctx.get?.("commands");
  if (commands) {
    tryRegisterCommand(commands, {
      name: "purge",
      description: "dsh 指令权威性清洗（status/apply/revert/uninstall/edit/help）",
      input: { hint: "status | apply | revert | uninstall | edit | help" },
      handler: async (invocation) => handlePurgeCommand(invocation.rawInput ?? "", cfg, ctx),
    }, ["purge-cmd"]);
    tryRegisterCommand(commands, {
      name: "rules",
      description: "规则集切换（写入 AGENTS.md/CLAUDE.md）: list | use <id> | create <id> [别名] [目标] | delete <id> | reset | help",
      input: { hint: "list | use <id> | create <id> [别名] [目标] | delete <id> | reset | help" },
      handler: async (invocation) => handleRulesCommand(invocation.rawInput ?? ""),
    }, ["purge-rules"]);
    tryRegisterCommand(commands, {
      name: "skills",
      description: "官方用户 Skill（$DSH_HOME/skills）：list | import <路径> | create <id> [说明] | delete <id> | help",
      input: { hint: "list | import <路径> | create <id> [说明] | delete <id> | help" },
      handler: async (invocation) => handleSkillsCommand(invocation.rawInput ?? ""),
    }, ["purge-skills"]);
    tryRegisterCommand(commands, {
      name: "rewind",
      description: "回退：子代理直接回退一次；主代理 /rewind once 或 /rewind round",
      input: { hint: "once | round" },
      handler: async (invocation) => {
        const sessionId = rewind.invocationSessionId(invocation);
        const arg = String(invocation.rawInput || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
        const info = await rewind.analyzeRewind(ctx, sessionId);
        if (info.ok && info.kind === "main" && arg !== "once" && arg !== "round") {
          return {
            kind: "success",
            text: "主代理请选择：/rewind once 回退一次，/rewind round 回退上一轮（含本轮子代理）。",
          };
        }
        const mode = arg === "round" ? "round" : "once";
        const result = await rewind.applyRewind(ctx, sessionId, mode);
        if (!result.ok) return { kind: "error", text: result.error };
        return {
          kind: "success",
          text: mode === "round"
            ? "已回退上一轮。还在这条对话里，上一句已放回输入框。再发送时，之前的回复不会带上。"
            : "已回退一次。还在这条对话里，上一句已放回输入框。再发送时，之前的回复不会带上。",
        };
      },
    }, ["purge-rewind"]);
    tryRegisterCommand(commands, {
      name: "prompt",
      description: "提示词快照（$DSH_HOME/dsh-purge/prompt-snapshots）：list | save <名字> | use <名字> | delete <名字> | help",
      input: { hint: "list | save <名字> | use <名字> | delete <名字> | help" },
      handler: async (invocation) => handlePromptCommand(invocation.rawInput ?? ""),
    }, ["purge-prompt"]);
    tryRegisterCommand(commands, {
      name: "export",
      description: "导出当前会话为 markdown 文件：/export [sessionId] [目标路径]",
      input: { hint: "[sessionId] [目标路径]" },
      handler: async (invocation) => handleExportCommand(
        invocation.rawInput ?? "",
        ctx,
        rewind.invocationSessionId(invocation),
      ),
    }, ["purge-export"]);
    tryRegisterCommand(commands, {
      name: "stats",
      description: "当前会话统计（消息数、角色分布、近似 token）：/stats [sessionId]",
      input: { hint: "[sessionId]" },
      handler: async (invocation) => handleStatsCommand(
        invocation.rawInput ?? "",
        ctx,
        rewind.invocationSessionId(invocation),
      ),
    }, ["purge-stats"]);
    tryRegisterCommand(commands, {
      name: "audit",
      description: "全破自检：核对会话门禁/外挂检测/演练台授权/默认提示词/hooks 旁路是否真的全开（100% 破甲）",
      // 宿主 dsh-commands 要求 input.hint 非空，空串会让整条命令注册失败
      // （"command \"audit\" input hint must not be empty"），且只在启动日志里留一行警告。
      input: { hint: "（无参数）" },
      handler: async () => {
        const result = await audit.runAudit(core.findDshHome());
        return { kind: result.full_break ? "success" : "error", text: audit.renderAudit(result) };
      },
    }, ["purge-audit"]);
    tryRegisterCommand(commands, {
      name: "verify",
      description: "行为级验甲：最近几轮真实装配里破甲有没有生效（空注入/首段丢失/尾部被包/注入层级）+ 最近会话权限档位",
      input: { hint: "[轮数，默认 8]" },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput ?? "").trim();
        const n = Number(raw.split(/\s+/)[0]);
        const result = verify.verifyArmor(Number.isFinite(n) && n > 0 ? { window: n } : {});
        let text = verify.renderVerify(result);
        const sessions = recentSessionPresets(ctx);
        if (sessions.length) {
          text += "\n\n  最近会话权限档位 / permission preset:";
          for (const s of sessions) text += `\n    · ${s.id || "(无 id)"} → ${s.preset}`;
        }
        return { kind: result.verdict === "live" ? "success" : "error", text };
      },
    }, ["purge-verify"]);
    tryRegisterCommand(commands, {
      name: "preflight",
      description: "补丁预检（只读）：apply 之前先说清已就位/将写入/锚点失配各多少条",
      // 同上：input.hint 空串会导致 dsh-commands 拒绝注册整条命令。
      input: { hint: "（无参数）" },
      handler: async () => {
        const result = await preflight.runPreflight({ patches: core.ALL_PATCHES });
        return { kind: result.verdict === "drift" ? "error" : "success", text: preflight.renderPreflight(result) };
      },
    }, ["purge-preflight"]);
    tryRegisterCommand(commands, {
      name: "trace",
      description: "破甲时间线：按轮聚合内部探针日志，看破甲在哪一层丢",
      input: { hint: "[轮数，默认 20]" },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput ?? "").trim();
        const n = Number(raw.split(/\s+/)[0]);
        const result = trace.analyzeTimeline({
          logPath: PURGE_INTERNAL_LOG,
          ...(Number.isFinite(n) && n > 0 ? { window: n } : {}),
        });
        return { kind: result.ok ? "success" : "error", text: trace.renderTimeline(result) };
      },
    }, ["purge-trace"]);
  }

  if (ctx.tools) {
    ctx.tools.register({
      name: "purge_status",
      description: `查看 dsh 指令权威性清洗状态（${core.ALL_PATCHES.length} patch 清洗进度、shim 注入、override 文件）。`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        const state = await core.gatherState();
        return { text: renderStatus(state) };
      },
    });
    ctx.tools.register({
      name: "purge_apply",
      description: `应用 dsh 指令权威性清洗：${core.ALL_PATCHES.length} patch（提示词层+代码默认+引擎级审批/沙箱绕过）+ shim 注入 + override 文件。需重启 dsh 完全生效。`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        core.applyRuntimeEnv();
        const scrubbed = core.sanitizeDesktopCommandRuntimes();
        const state = await core.gatherState();
        if (!state.ai_base) return { text: "ERROR: " + core.missingAiBaseMessage() };
        const blocked = rejectIfNeedPrompt(state.dsh_home);
        if (blocked) return { text: "ERROR: " + blocked.error };
        const toolMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
          preserveClientBundles: false,
          forApply: true,
        });
        await core.patchAllShims();
        const flash = core.silenceCmdFlash(toolMulti.hosts[0]?.aiBase || state.ai_base);
        const report = toolMulti.report;
        const applied = report.filter((r) => r.status === "applied").length;
        const already = report.filter((r) => r.status === "already").length;
        const scrubNote = scrubbed.length ? ` desktop_scrub=${scrubbed.length}` : "";
        return { text: `清洗完成 / applied=${applied}, already=${already}.${scrubNote} phase-1=${flash.phase1} 重启 dsh 生效.` };
      },
    });
    ctx.tools.register({
      name: "purge_revert",
      description: "回滚 dsh 指令权威性清洗到备份原件（保留 prompt-inject.md 用户文件）。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        const state = await core.gatherState();
        const lines = [];
        if (state.ai_base) {
          const { reverted, errors } = await core.revertAll(state.ai_base);
          lines.push(`reverted=${reverted.length}${errors.length ? ` errors=${errors.length}` : ""}`);
        }
        const shimRevert = await core.revertAllShims();
        lines.push(`shim_dirs=${Object.keys(shimRevert).length}`);
        return { text: `回滚完成 / ${lines.join(", ")}. 重启 dsh 恢复.` };
      },
    });
    ctx.tools.register({
      name: "purge_prompt_snapshot",
      description: "提示词快照：save 保存当前 prompt-inject.md 为命名快照；use 恢复指定快照；list 列出全部快照。操作 $DSH_HOME/dsh-purge/prompt-snapshots。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", description: "list | save | use | delete" },
          name: { type: "string", description: "快照名字（save/use/delete 必填）" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute(args) {
        const dshHome = core.findDshHome();
        const action = String(args?.action || "list").toLowerCase();
        const name = String(args?.name || "").trim();
        try {
          if (action === "list") {
            return { text: promptSnapshots.renderSnapshotStatus(await promptSnapshots.snapshotStatus(dshHome)) };
          }
          if (action === "save") {
            if (!name) return { text: "ERROR: name required" };
            const saved = await promptSnapshots.saveSnapshot(dshHome, name);
            return { text: `已保存快照 ${saved.name}（${saved.size} B）` };
          }
          if (action === "use") {
            if (!name) return { text: "ERROR: name required" };
            const used = await promptSnapshots.useSnapshot(dshHome, name);
            refreshHungOperator(dshHome);
            return { text: `已恢复快照 ${used.name} → prompt-inject.md，新会话生效` };
          }
          if (action === "delete") {
            if (!name) return { text: "ERROR: name required" };
            const removed = await promptSnapshots.deleteSnapshot(dshHome, name);
            return { text: `已删除快照 ${removed.name}` };
          }
          return { text: "ERROR: action must be list | save | use | delete" };
        } catch (e) {
          return { text: `ERROR: ${e.message}` };
        }
      },
    });
    ctx.tools.register({
      name: "purge_session_export",
      description: "导出当前会话为 markdown 文件。不传 filePath 时写到工作目录 dsh-session-export-<时间戳>.md。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          filePath: { type: "string", description: "可选，目标文件路径（相对路径基于会话 cwd）" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute(args) {
        try {
          const result = await sessionTools.exportSessionToFile(ctx, "", String(args?.filePath || ""));
          return { text: `已导出会话 → ${result.path}（${result.bytes} B · ${result.lines} 行）` };
        } catch (e) {
          return { text: `ERROR: ${e.message}` };
        }
      },
    });
    ctx.tools.register({
      name: "purge_session_stats",
      description: "当前会话统计：事件数、轮次、消息数、角色分布、近似 token。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { text: { type: "string" } },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        try {
          const stats = await sessionTools.sessionStats(ctx, "");
          return { text: sessionTools.renderSessionStats(stats) };
        } catch (e) {
          return { text: `ERROR: ${e.message}` };
        }
      },
    });
    ctx.tools.register({
      name: "purge_audit",
      description: "全破自检：核对会话门禁/外挂检测/演练台授权/默认提示词/hooks 旁路是否真的全开（100% 破甲），返回逐项 pass/fail。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            full_break: { type: "boolean" },
            passed: { type: "number" },
            total: { type: "number" },
          },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        try {
          const result = await audit.runAudit(core.findDshHome());
          return {
            text: audit.renderAudit(result),
            full_break: result.full_break,
            passed: result.passed,
            total: result.total,
          };
        } catch (e) {
          return { text: `ERROR: ${e.message}`, full_break: false, passed: 0, total: 0 };
        }
      },
    });
    // ── [2.3.0] L4 观测层 ────────────────────────────────────────────────
    // 破甲有四个层：提示词层、引擎层（字节补丁）、门禁层、观测层。
    // 前三个本插件早已做完；第四个是缺口——没有任何工具回答「这一刻模型真的被破了没有」。
    // 下面三个工具补的就是这一层，全部只读、绝不改宿主文件。
    ctx.tools.register({
      name: "purge_verify",
      description: "行为级验甲：读飞行记录仪，回答最近 N 轮真实装配里破甲有没有生效（空注入 / 首段丢失 / 闭合标签被包 / 注入来自哪一层 fallback），并列出最近会话的权限档位。与 purge_audit 互补：audit 证明代码长得像破甲，verify 证明这一刻模型真被破了。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          window: { type: "number", description: "回看最近多少轮装配（默认 8，上限 64）" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            verdict: { type: "string" },
            score: { type: "number" },
          },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute(args) {
        try {
          const window = Number(args?.window);
          const result = verify.verifyArmor(Number.isFinite(window) ? { window } : {});
          let text = verify.renderVerify(result);
          const sessions = recentSessionPresets(ctx);
          if (sessions.length) {
            text += "\n\n  最近会话权限档位 / permission preset:";
            for (const s of sessions) text += `\n    · ${s.id || "(无 id)"} → ${s.preset}`;
          }
          return { text, verdict: result.verdict, score: result.score };
        } catch (e) {
          return { text: `ERROR: ${e.message}`, verdict: "error", score: 0 };
        }
      },
    });
    ctx.tools.register({
      name: "purge_preflight",
      description: `补丁预检（只读）：apply 之前先说清这次会发生什么——已就位 / 将写入 / 锚点失配各多少条，并按层分组。锚点失配是宿主升级导致的真漂移，改配置无效，只能补新锚点。共 ${core.ALL_PATCHES.length} 条补丁。`,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            verdict: { type: "string" },
            will_fail: { type: "number" },
          },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute() {
        try {
          const result = await preflight.runPreflight({ patches: core.ALL_PATCHES });
          return {
            text: preflight.renderPreflight(result),
            verdict: result.verdict,
            will_fail: result.forecast?.willFail || 0,
          };
        } catch (e) {
          return { text: `ERROR: ${e.message}`, verdict: "error", will_fail: -1 };
        }
      },
    });
    ctx.tools.register({
      name: "purge_trace",
      description: "破甲时间线：解析内部日志探针（assemble.entry / inject.read / assemble.rewrite / host.hungFn），按轮聚合，标出空注入、首段丢失、下游抛错，回答最近这些轮破甲是在哪一层丢的。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          window: { type: "number", description: "看最近多少轮（默认 20）" },
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            collapsed: { type: "number" },
          },
        },
        render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
      },
      async execute(args) {
        try {
          const window = Number(args?.window);
          const result = trace.analyzeTimeline({
            logPath: PURGE_INTERNAL_LOG,
            ...(Number.isFinite(window) ? { window } : {}),
          });
          return {
            text: trace.renderTimeline(result),
            collapsed: result.totals?.collapsed || 0,
          };
        } catch (e) {
          return { text: `ERROR: ${e.message}`, collapsed: -1 };
        }
      },
    });
  }
}

function headerOf(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function denyCrossOrigin(response) {
  response.writeHead(403, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ ok: false, error: "cross-origin blocked" }));
}

function allowPluginRequest(request, response) {
  const site = headerOf(request, "sec-fetch-site").toLowerCase();
  if (site === "cross-site") {
    denyCrossOrigin(response);
    return false;
  }
  const origin = headerOf(request, "origin").trim();
  if (origin === "null") {
    denyCrossOrigin(response);
    return false;
  }
  if (!origin) return true;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    denyCrossOrigin(response);
    return false;
  }
  const host = headerOf(request, "host").trim();
  if (!host || originHost.toLowerCase() !== host.toLowerCase()) {
    denyCrossOrigin(response);
    return false;
  }
  return true;
}

function installWebServer(ctx, cfg) {
  // 桌面端内嵌 @deepseek-ai/dsh-web-app，设置页同样走 webServer（常见 43120），不是只给官方 dsh web。
  watchWebTreeReady(ctx);
  ctx.inject(["webServer"], (host) => {
    host.effect(() => {
      // 收集所有子路由的 unregister disposer；host.effect 的 cleanup 一把全撤。
      // 旧版本只注册不收，plugin reload 时上一轮的 handler 仍挂着，新的叠在之上。
      const routeDisposers = [];
      const trackRoute = (d) => {
        if (typeof d === "function") routeDisposers.push(d);
        return d;
      };
      const registerPluginRoute = (spec, label) => {
        // v2.2.1：单条路由注册失败（路径撞车 / 宿主校验）只丢这一条，不能连累其它路由，
        // 更不能让异常冒出去把整个 host.effect 回调打断。
        try {
          return trackRoute(host.webServer.register({
            ...spec,
            handler: async (request, response) => {
              try {
                if (!allowPluginRequest(request, response)) return;
                return await spec.handler(request, response);
              } catch (e) {
                try {
                  sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
                } catch { /* 响应已结束时忽略 */ }
              }
            },
          }, label));
        } catch (e) {
          console.warn(`[dsh-purge] route ${label || spec?.path} register failed:`, e && e.message ? e.message : e);
          return () => {};
        }
      };
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/probe",
        handler: async (request, response) => {
          const home = core.findDshHome();
          if (request.method === "GET") {
            try {
              const live = probe.readProbe(home);
              // 装配侧验证：直接读最近会话的 system prompt。
              // 这条路不依赖模型配合回显，是「注入到底到没到」的硬判据。
              let injection = null;
              try {
                injection = probe.inspectInjection(home, live?.nonce || "", { limit: 3 });
              } catch (e) {
                injection = { injected: false, reason: "inspect-failed: " + String(e && e.message ? e.message : e) };
              }
              sendJson(response, 200, {
                ok: true,
                active: Boolean(live),
                nonce: live?.nonce || "",
                age_ms: live?.ageMs || 0,
                ttl_ms: probe.PROBE_TTL_MS,
                order: cfg.probeOrder ?? probe.PROBE_ORDER,
                message: live ? probe.probeMessage(live.nonce) : "",
                path: probe.probePath(home),
                injected: Boolean(injection?.injected),
                injection,
              });
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error && error.message ? error.message : error) });
            }
            return;
          }
          if (request.method === "DELETE") {
            const r = probe.clearProbe(home);
            sendJson(response, 200, { ok: true, ...r });
            return;
          }
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "GET, POST, DELETE" });
            response.end();
            return;
          }
          try {
            let body = "";
            for await (const chunk of request) {
              body += chunk;
              if (body.length > 65536) throw new Error("body too large");
            }
            const parsed = body.trim() ? JSON.parse(body) : {};
            const made = probe.createProbe(home, parsed.nonce);
            sendJson(response, 200, { ok: true, ...made, path: probe.probePath(home) });
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error && error.message ? error.message : error) });
          }
        },
      });

      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/retry",
        handler: async (request, response) => {
          const home = core.findDshHome();
          if (request.method === "GET") {
            try {
              const saved = refusalRetry.loadSettings(home);
              sendJson(response, 200, {
                ok: true,
                ...refusalRetry.mergeConfig(cfg, saved),
                saved,
                defaults: refusalRetry.DEFAULT_REFUSAL_RETRY,
                settings_path: refusalRetry.settingsPath(home),
                log_path: refusalRetry.logPath(home),
                recent: refusalRetry.readLog(home, 25),
              });
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error && error.message ? error.message : error) });
            }
            return;
          }
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "GET, POST" });
            response.end();
            return;
          }
          let body = "";
          try {
            for await (const chunk of request) {
              body += chunk;
              if (body.length > 65536) throw new Error("body too large");
            }
            const parsed = body.trim() ? JSON.parse(body) : {};
            const patch = {};
            if (typeof parsed.refusalRetry === "boolean") patch.refusalRetry = parsed.refusalRetry;
            if (typeof parsed.refusalDecompose === "boolean") patch.refusalDecompose = parsed.refusalDecompose;
            if (parsed.refusalMax !== undefined) patch.refusalMax = parsed.refusalMax;
            const saved = refusalRetry.saveSettings(home, patch);
            sendJson(response, 200, {
              ok: true,
              ...refusalRetry.mergeConfig(cfg, saved),
              saved,
              settings_path: refusalRetry.settingsPath(home),
            });
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error && error.message ? error.message : error) });
          }
        },
      });
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/status",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const progress = getApplyProgress();
            if (progress.active) {
              const base = lastStatusPayload || { ok: true };
              sendJson(response, 200, {
                ...base,
                ok: true,
                ready: webTreeReady || Boolean(lastStatusPayload),
                apply_progress: progress,
              });
              return;
            }
            if (!webTreeReady) {
              sendJson(response, 503, { ok: false, ready: false, apply_progress: progress });
              return;
            }
            const state = await core.gatherState();
            const patch_names = {};
            for (const p of core.ALL_PATCHES) patch_names[String(p.id)] = p.name;
            const payload = {
              ok: true,
              ready: true,
              surface: state.surface || hostctl.currentSurface(),
              ai_base: state.ai_base,
              desktop_install: state.desktop_install || "",
              desktop_exe: state.desktop_exe || "",
              asar_still_sealed: state.asar_still_sealed || false,
              missing_ai_base: state.ai_base ? "" : core.missingAiBaseMessage(),
              patches_applied: state.ai_base ? (state.display_applied ?? state.patches_applied) : 0,
              patches_pending: state.display_pending ?? state.patches_pending,
              patches_skipped: state.display_skipped ?? state.patches_skipped ?? 0,
              patches_ready: state.display_ready ?? state.patches_ready ?? 0,
              patches_na: state.patches_na || 0,
              patches_total: state.ai_base ? (state.display_total ?? state.patches_total ?? 0) : 0,
    patches_optional: state.ai_base ? (state.patches_optional ?? 0) : 0,
    plugin_conflicts: state.ai_base ? (state.plugin_conflicts ?? null) : null,
              patches_lost: reapply.patchesLostAfterHostReset(),
              // assembleGuard 吞掉的异常次数。非 0 = 装配层炸过，工具 schema 可能被空装配抹掉。
              assemble_failures: assembleFailureStats(),
              patch_status: state.patch_status,
              patches: (state.display_patches || []).map((p) => ({
                id: p.id,
                ids: p.ids,
                layer: p.layer || "",
                status: p.status,
              })),
              patch_names,
              shim_cmd: state.shim_cmd,
              shim_ps1: state.shim_ps1,
              shim_bin: state.shim_bin,
              has_backup: state.has_backup,
              override_status: state.override_status,
              override_path: state.override_path,
              dsh_home: state.dsh_home,
              plugin_version: updater.localVersion(),
              boot_full_quit: bootFullQuit,
              update: updater.lastUpdateResult(),
              ...updater.channelPublic(),
              hooks_deny_bypass: core.getHooksDenySettings().hooksDenyBypass,
              ...(await skills.skillsStatus(core.findDshHome()).catch(() => ({ skills: [] }))),
            };
            lastStatusPayload = payload;
            sendJson(response, 200, { ...payload, apply_progress: progress });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e), apply_progress: getApplyProgress() });
          }
        },
      }, "dsh-purge: status");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/hooks-deny",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const settings = core.refreshHooksDenySettings();
              sendJson(response, 200, { ok: true, hooksDenyBypass: settings.hooksDenyBypass });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              if (typeof body?.hooksDenyBypass !== "boolean") {
                sendJson(response, 400, { ok: false, error: "hooksDenyBypass must be boolean" });
                return;
              }
              const saved = core.setHooksDenySettings({ hooksDenyBypass: body.hooksDenyBypass });
              sendJson(response, 200, { ok: true, hooksDenyBypass: saved.hooksDenyBypass });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: hooks-deny");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/last-user",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const url = new URL(request.url, "http://127.0.0.1");
            const sessionId = String(url.searchParams.get("sessionId") || "").trim();
            sendJson(response, 200, await rewind.readLastUserText(ctx, sessionId));
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: last user");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/rewind/options",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const url = new URL(request.url, "http://127.0.0.1");
            const sessionId = String(url.searchParams.get("sessionId") || "").trim();
            sendJson(response, 200, await rewind.analyzeRewind(ctx, sessionId));
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: rewind options");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/rewind",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const url = new URL(request.url, "http://127.0.0.1");
              const sessionId = url.searchParams.get("sessionId");
              if (sessionId) {
                const draft = rewind.takeDraft(sessionId);
                sendJson(response, 200, { ok: true, ...(draft || {}) });
                return;
              }
              const pending = rewind.getPending();
              sendJson(response, 200, { ok: true, ...(pending || {}) });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const sessionId = String(body?.sessionId || "").trim();
              if (!sessionId) {
                sendJson(response, 400, { ok: false, error: "需要 sessionId" });
                return;
              }
              const mode = body?.mode === "round" ? "round" : "once";
              const result = await rewind.applyRewind(ctx, sessionId, mode);
              sendJson(response, result.ok ? 200 : 409, result);
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: rewind");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/update",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              sendJson(response, 200, await updater.checkUpdate());
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const result = await updater.handleUpdateOp(body || {});
              if (result && result.needsFullQuit) bootFullQuit = true;
              sendJson(response, 200, result);
              if (result && result.restartAfter) {
                try { hostctl.scheduleRestart(request, ctx); } catch (e) {
                  console.warn("[dsh-purge] update restart failed:", e);
                }
              }
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: update");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/apply",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          beginApply("home");
          try {
            const body = await readJsonBody(request);
            const incoming = typeof body?.content === "string" ? body.content : null;
            core.applyRuntimeEnv();
            core.clearDesktopLocateCache();
            const home = core.pinDshHome();
            const scrubbed = core.sanitizeDesktopCommandRuntimes();
            const state = await core.gatherState();
            if (home) state.dsh_home = home;
            let located;
            setApplyProgress({ stage: "locate" });
            try {
              located = await core.resolveOfficialAiBase(state.ai_base, { forApply: true });
            } catch (e) {
              endApply({ stage: "locate", error: String(e && e.message ? e.message : e) });
              sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
              return;
            }
            if (!located.aiBase) {
              endApply({ stage: "locate", error: "no_base" });
              sendJson(response, 500, { ok: false, error: core.missingAiBaseMessage() });
              return;
            }
            state.ai_base = located.aiBase;
            if (located.extracted) {
              const arch = located.handoff?.archive;
              if (arch) core.writeUnpackedAsarStamp(arch);
            }
            const handoff = located.handoff && located.handoff.swapAsar ? located.handoff : null;
            const blocked = rejectIfNeedPrompt(state.dsh_home, incoming === null ? undefined : incoming);
            if (blocked) {
              resetApplyProgress();
              const ui = await core.readOverrideForUi(state.dsh_home);
              sendJson(response, 400, {
                ok: false,
                needPrompt: true,
                override_content: incoming || "",
                defaultContent: ui.defaultContent,
                ...blocked,
              });
              return;
            }
            setApplyProgress({ stage: "override" });
            try {
              await core.commitOverrideOnApply(state.dsh_home, incoming);
            } catch (e) {
              console.warn("[dsh-purge] apply override:", String(e && e.message ? e.message : e));
            }
            setApplyProgress({ stage: "patch" });
            // 密封 asar 时，applyPatchesAllHosts 内部会先把 213 MB 的 app.asar
            // 解到 resources\app（落盘 400+ MB，几十秒）。先给前端一句话，
            // 否则进度条停在 patch 阶段会被当成卡死。
            if (core.desktopAsarStillSealed()) {
              setApplyProgress({
                stage: "patch",
                applied: 0,
                detail: "正在解包 app.asar（约 200 MB / 落盘 400 MB），预计 30–90 秒，请勿关闭…",
              });
            }
            const httpMulti = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
              preserveClientBundles: false,
              forApply: true,
              onHost(info) {
                setApplyProgress({
                  stage: "patch",
                  applied: info.index || 0,
                  detail: info.aiBase || "",
                });
              },
            });
            const report = httpMulti.report;
            setApplyProgress({ stage: "shim" });
            const shim = await core.patchAllShims();
            let cliRepair = null;
            try {
              cliRepair = core.repairOfficialCliAfterUnpack();
            } catch (e) {
              cliRepair = { ok: false, error: String(e && e.message ? e.message : e) };
            }
            setApplyProgress({ stage: "flash" });
            const flash = core.silenceCmdFlash(httpMulti.hosts[0]?.aiBase || state.ai_base);
            const summary = core.summarizeApplyReport(report);
            const hostWritten =
              core.allPatchHostsWritten(httpMulti.hosts) || core.hostCleanMarkersPresent(state.ai_base);
            const hookDenyRestoreFailed = (httpMulti.hookDenyRestoreFailed || []).length > 0;
            const complete = summary.failed.length === 0 && flash.ok === true && hostWritten && !hookDenyRestoreFailed;
            const sealedNow = core.desktopAsarStillSealed();
            const promptReady = summary.failed.length > 0 && summary.failed.every((item) => item.status === "pattern_not_found");
            if (flash.ok === true && (complete || promptReady) && hostWritten) {
              reapply.markPatchesApplied();
            }
            // 全部洗完且标记进宿主才弹重启；密封包重启时换走 asar。
            const shouldRestart = applyShouldRestart({
              complete: complete || (promptReady && hostWritten),
              sealed: sealedNow,
              appliedCount: summary.applied,
              promptReady: promptReady && hostWritten,
            });
            if (shouldRestart && handoff && sealedNow) bootFullQuit = true;
            else bootFullQuit = false;
            if (shouldRestart) reapply.markSettleRestart();
            let promptInjectInstall = "skipped";
            setApplyProgress({ stage: "seed" });
            if (hostWritten && flash.ok === true) {
              // Apply → cleanup → restart 成功后，默认把加密提示词 seed 进 prompt-inject.md。
              // 用户自改过的内容保留；仅当文件不存在或仍是插件旧默认时才写。
              try {
                const seed = core.seedPromptInjectAtBoot(state.dsh_home);
                promptInjectInstall = seed?.action || "noop";
              } catch (e) {
                promptInjectInstall = `error:${String(e && e.message ? e.message : e)}`;
              }
            }
            const hung = refreshHungOperator(state.dsh_home);
            const override = await core.readOverrideForUi(state.dsh_home);
            endApply({
              stage: "done",
              error: complete || (promptReady && hostWritten) ? "" : "incomplete",
            });
            sendJson(response, 200, {
              ok: true,
              complete,
              restarting: shouldRestart,
              restart_after_apply: shouldRestart,
              unpacked_asar: shouldRestart,
              needs_full_quit: shouldRestart,
              asar_still_sealed: sealedNow,
              asar_swap_started: Boolean(shouldRestart && handoff && sealedNow),
              applied: summary.applied,
              already: summary.already,
              failed: summary.failed.length,
              failed_items: summary.failed.map((r) => ({
                id: r.patch_id,
                name: r.name,
                status: r.status,
              })),
              report: report.map((r) => ({ id: r.patch_id, name: r.name, status: r.status })),
              override_content: hung.text || override.content,
              defaultContent: override.defaultContent,
              ...injectSnapshot(state.dsh_home),
              override_path: override.path,
              override_installed: promptInjectInstall,
              shim,
              desktop_scrubbed: scrubbed,
              cli_repair: cliRepair,
              cmd_flash: flash,
            });
          } catch (e) {
            endApply({ error: String(e && e.message ? e.message : e) });
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: apply");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/revert",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          beginJob("revert", "locate");
          try {
            const state = await core.gatherState();
            const result = {};
            setApplyProgress({ kind: "revert", stage: "revert" });
            if (state.ai_base) {
              const { reverted, errors } = await core.revertAll(state.ai_base);
              result.reverted = reverted.length;
              result.errors = errors.length;
            }
            setApplyProgress({ kind: "revert", stage: "shim" });
            result.shim = await core.revertAllShims();
            endApply({
              kind: "revert",
              stage: "done",
              error: result.errors ? "incomplete" : "",
            });
            sendJson(response, 200, { ok: true, ...result, note: "重启 dsh 恢复; prompt-inject.md 保留" });
          } catch (e) {
            endApply({ kind: "revert", error: String(e && e.message ? e.message : e) });
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: revert");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/uninstall",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          beginJob("uninstall", "locate");
          try {
            const result = await uninstaller.uninstallPurge({
              onStage(stage) {
                setApplyProgress({ kind: "uninstall", stage });
              },
            });
            endApply({
              kind: "uninstall",
              stage: "done",
              error: result.ok ? "" : (result.errors && result.errors[0]) || "incomplete",
            });
            sendJson(response, result.ok ? 200 : 500, {
              ...result,
              surface: hostctl.currentSurface(),
              fullApp: hostctl.currentSurface() === "desktop",
              note: result.ok ? hostctl.restartNote() : undefined,
            });
            if (result.ok) {
              uninstaller.scheduleCleanupRestart({
                request,
                cleanup: result.cleanup,
                ctx,
              });
            }
          } catch (e) {
            endApply({ kind: "uninstall", error: String(e && e.message ? e.message : e) });
            sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
          }
        },
      }, "dsh-purge: uninstall");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/drill-grant",
        handler: async (request, response) => {
          const home = core.findDshHome();
          if (request.method === "GET") {
            sendJson(response, 200, { ok: true, ...readDrillGrant(home) });
            return;
          }
          if (request.method === "POST") {
            sendJson(response, 200, { ok: true, ...writeDrillGrant(home) });
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: drill-grant");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/override",
        handler: async (request, response) => {
          if (request.method === "GET") {
            try {
              const home = core.findDshHome();
              // 面板打开 override 面板时，确保默认加密提示词已 seed；用户自改保留。
              try { core.seedPromptInjectAtBoot(home); } catch { /* ignore */ }
              refreshHungOperator(home);
              const ui = await core.readOverrideForUi(home);
              sendJson(response, 200, { ok: true, ...ui, ...injectSnapshot(home) });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const content = typeof body?.content === "string" ? body.content : null;
              if (content === null) {
                sendJson(response, 400, { ok: false, error: "content must be a string" });
                return;
              }
              const home = core.findDshHome();
              const blocked = rejectIfNeedPrompt(home, content);
              if (blocked) {
                sendJson(response, 400, {
                  ok: false,
                  content,
                  ...blocked,
                });
                return;
              }
              const saved = await core.saveOverrideContent(home, content);
              const hung = refreshHungOperator(home);
              const ui = await core.readOverrideForUi(home);
              sendJson(response, 200, {
                ok: true,
                content: hung.text,
                defaultContent: saved.defaultContent,
                customized: ui.customized,
                usingDefault: ui.usingDefault,
                path: ui.path,
                ...injectSnapshot(home),
              });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: override");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/own-servers",
        handler: async (request, response) => {
          const home = core.findDshHome();
          if (request.method === "GET") {
            sendJson(response, 200, { ok: true, content: readAllowText(home) });
            return;
          }
          if (request.method === "POST") {
            try {
              const body = await readJsonBody(request);
              const content = typeof body?.content === "string" ? body.content : null;
              if (content === null) {
                sendJson(response, 400, { ok: false, error: "content must be a string" });
                return;
              }
              const saved = await writeAllowText(home, content);
              sendJson(response, 200, { ok: true, content: saved.text, dropped: saved.dropped });
            } catch (e) {
              sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
            }
            return;
          }
          response.writeHead(405, { allow: "GET, POST" });
          response.end();
        },
      }, "dsh-purge: own-servers");
      trackRoute(installRulesHttp(host.webServer));
      trackRoute(installSkillsHttp(host.webServer));
      trackRoute(installPromptSnapshotsHttp(host.webServer));
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/audit",
        handler: async (request, response) => {
          if (request.method !== "GET") {
            response.writeHead(405, { allow: "GET" });
            response.end();
            return;
          }
          try {
            const result = await audit.runAudit(core.findDshHome());
            sendJson(response, 200, { ok: true, ...result, text: audit.renderAudit(result) });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
          }
        },
      }, "dsh-purge: audit");
      registerPluginRoute({
        kind: "exact",
        path: "/dsh-purge/restart",
        handler: async (request, response) => {
          if (request.method !== "POST") {
            response.writeHead(405, { allow: "POST" });
            response.end();
            return;
          }
          try {
            const ready = await ensureRestartReady();
            if (!ready.ok) {
              bootFullQuit = false;
              sendJson(response, 200, {
                ok: false,
                error: ready.error || "清洗没有完成，已取消重启",
                restarting: false,
                pending: ready.pending || [],
              });
              return;
            }
            const surface = hostctl.currentSurface();
            let planned = null;
            if (core.desktopAsarStillSealed()) {
              planned = core.restartSealedDesktopIfNeeded({ ctx });
            } else {
              planned = hostctl.scheduleRestart(request, ctx);
            }
            if (planned && planned.clean === false) {
              bootFullQuit = false;
              sendJson(response, 200, {
                ok: false,
                error: "清洗没有写进当前宿主，已取消重启",
                restarting: false,
              });
              return;
            }
            // 用户已点重启：清掉粘性标记，避免同进程误刷新/再进面板又弹一次。
            bootFullQuit = false;
            const restarting = Boolean(planned && (planned.restarting || planned.asarSwap));
            const restartError = planned && planned.error ? String(planned.error) : "";
            sendJson(response, 200, {
              ok: restarting || !restartError,
              surface,
              fullApp: surface === "desktop",
              restarting,
              already: Boolean(planned && planned.already),
              needsFullQuit: Boolean(planned && planned.asarSwap),
              asar_still_sealed: core.desktopAsarStillSealed(),
              error: restartError || undefined,
              note: restarting ? "正在重启。" : restartError,
            });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: String(e) });
          }
        },
      }, "dsh-purge: restart");
      return () => {
        for (let i = routeDisposers.length - 1; i >= 0; i -= 1) {
          try { routeDisposers[i](); } catch { /* ignore */ }
        }
        routeDisposers.length = 0;
      };
    }, "dsh-purge: http routes");
  });
}

function methodNotAllowed(request, response, allow) {
  if (allow.includes(request.method)) return false;
  response.writeHead(405, { allow: allow.join(", ") });
  response.end();
  return true;
}

async function handleRulesOp(op, body, queryId, queryCwd) {
  const dshHome = core.findDshHome();
  const id = typeof body?.id === "string" ? body.id : String(queryId || "");
  const cwdHint = typeof body?.cwd === "string" && body.cwd.trim()
    ? body.cwd.trim()
    : (typeof queryCwd === "string" && queryCwd.trim() ? queryCwd.trim() : "");
  if (cwdHint) {
    try { rules.writeLastCwd(dshHome, cwdHint); } catch { /* ignore */ }
  }
  if (op === "status") {
    return { ok: true, ...(await rules.rulesStatus(dshHome, cwdHint)) };
  }
  if (op === "scan-cwd" || op === "scan") {
    const effective = cwdHint || rules.readLastCwd(dshHome);
    const candidates = effective ? rules.scanCwdInstructions(effective) : [];
    const selections = rules.readCwdSelections(dshHome);
    return {
      ok: true,
      cwd: effective,
      candidates: candidates.map((item) => ({ ...item, selected: selections.includes(item.path) })),
      selections,
    };
  }
  if (op === "toggle-cwd") {
    const target = typeof body?.path === "string" ? body.path.trim() : "";
    if (!target) return { status: 400, ok: false, error: "path required" };
    const enabled = body?.enabled !== false;
    const next = await rules.toggleCwdSelection(dshHome, target, enabled);
    return { ok: true, selections: next };
  }
  if (op === "set-policy" || op === "workspace-policy") {
    const policy = typeof body?.policy === "string" ? body.policy.trim() : "";
    if (!rules.WORKSPACE_POLICIES.includes(policy)) {
      return { status: 400, ok: false, error: `invalid policy: ${policy}` };
    }
    const applied = await rules.writeWorkspacePolicy(dshHome, policy);
    return { ok: true, policy: applied, policies: [...rules.WORKSPACE_POLICIES] };
  }
  if (op === "read") {
    if (!rules.validRuleId(id)) return { status: 400, ok: false, error: "invalid id" };
    const content = await rules.readRule(dshHome, id);
    if (content === null) return { status: 404, ok: false, error: `rule not found: ${id}` };
    const meta = await rules.readRuleMeta(dshHome, id);
    return { ok: true, id, name: meta.name, target: meta.target, content };
  }
  if (op === "save") {
    const content = typeof body?.content === "string" ? body.content : null;
    if (!rules.validRuleId(id) || content === null) {
      return { status: 400, ok: false, error: "id and content (string) required" };
    }
    const target = typeof body?.target === "string" ? body.target : undefined;
    // 旧版本直接把 body.target 写进 rules.saveRule；非法目标会污染 agents_path 推导。
    if (target !== undefined && !rules.validTarget(target)) {
      return { status: 400, ok: false, error: `invalid target: ${target}（只能是 AGENTS.md 或 CLAUDE.md）` };
    }
    await rules.saveRule(dshHome, id, content, {
      name: typeof body?.name === "string" ? body.name : undefined,
      target,
    });
    refreshHungOperator(dshHome);
    return { ok: true, id, ...injectSnapshot(dshHome) };
  }
  if (op === "activate") {
    if (!rules.validRuleId(id)) return { status: 400, ok: false, error: "invalid id" };
    const meta = await rules.activateRule(dshHome, id);
    refreshHungOperator(dshHome);
    return {
      ok: true,
      id,
      name: meta.name,
      target: meta.target,
      agents_path: rules.targetPath(dshHome, meta.target),
      note: "已写入目标文件并注入 systemPrompt，新会话生效",
      ...injectSnapshot(dshHome),
    };
  }
  if (op === "delete") {
    if (!rules.validRuleId(id)) return { status: 400, ok: false, error: "invalid id" };
    await rules.deleteRule(dshHome, id);
    refreshHungOperator(dshHome);
    return { ok: true, id };
  }
  if (op === "reset") {
    const r = await rules.resetToOriginal(dshHome);
    refreshHungOperator(dshHome);
    return { ok: true, ...r, note: "已还原出厂状态（无全局指令）；规则库保留" };
  }
  return { status: 400, ok: false, error: `unknown op: ${op}` };
}

function rulesHttpHandler(forcedOp) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      sendOptions(response);
      return;
    }
    // v2.2.1：不再用 methodNotAllowed 回 405。除 OPTIONS 外一律按请求处理
    // （POST 才读 body），彻底消除面板「读取失败: 405 Method Not Allowed」。
    try {
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      const tail = url.pathname.replace(/^\/dsh-purge\/rules\/?/, "").replace(/\/$/, "");
      let body = {};
      if (request.method === "POST") body = await readJsonBody(request);
      const op = forcedOp || body.op || tail || "status";
      const result = await handleRulesOp(op, body, url.searchParams.get("id"), url.searchParams.get("cwd"));
      sendJson(response, result.status || 200, result);
    } catch (e) {
      sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  };
}

async function handleSkillsOp(op, body, queryId) {
  const dshHome = core.findDshHome();
  const id = typeof body?.id === "string" ? body.id : String(queryId || "");
  if (op === "status") {
    return { ok: true, ...(await skills.skillsStatus(dshHome)) };
  }
  if (op === "read") {
    if (!skills.validSkillName(id)) return { status: 400, ok: false, error: "invalid skill name" };
    const item = await skills.readSkill(dshHome, id);
    if (!item) return { status: 404, ok: false, error: `skill not found: ${id}` };
    return { ok: true, ...skills.toPublicSkill(dshHome, item) };
  }
  if (op === "save") {
    if (!skills.validSkillName(id)) return { status: 400, ok: false, error: "id 必须是 kebab-case，例如 code-review" };
    const content = typeof body?.content === "string" ? body.content : "";
    const description = typeof body?.description === "string" ? body.description : "";
    const saved = await skills.saveSkill(dshHome, id, content, description);
    return { ok: true, ...skills.toPublicSkill(dshHome, saved) };
  }
  if (op === "delete") {
    if (!skills.validSkillName(id)) return { status: 400, ok: false, error: "invalid skill name" };
    const removed = await skills.deleteSkill(dshHome, id);
    return { ok: true, ...skills.toPublicSkill(dshHome, removed) };
  }
  if (op === "import") {
    if (body?.path || body?.source || body?.folder) {
      return { status: 400, ok: false, error: "请在本机选择压缩包或文件夹导入" };
    }
    if (typeof body?.data === "string" && body.data.trim()) {
      const packed = await skills.importArchive(dshHome, Buffer.from(body.data, "base64"), body.name || "skill.zip");
      return { ok: true, ...packed };
    }
    if (Array.isArray(body?.files) && body.files.length) {
      const packed = await skills.importFileTree(dshHome, body.files, body.name || "");
      return { ok: true, ...packed };
    }
    return { status: 400, ok: false, error: "请选择压缩包或文件夹" };
  }
  return { status: 400, ok: false, error: `unknown op: ${op}` };
}

function skillsHttpHandler(forcedOp) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      sendOptions(response);
      return;
    }
    // v2.2.1：不再对非 GET/POST 方法回 405（宿主/面板偶尔用 HEAD、PUT 探测，
    // 一律按 GET 处理，避免面板显示「读取失败: 405 Method Not Allowed」）。
    try {
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      const tail = skillRouteTail(url.pathname);
      const body = request.method === "POST" ? await readJsonBody(request, 14 * 1024 * 1024) : {};
      const op = forcedOp
        || body.op
        || tail
        || url.searchParams.get("op")
        || (url.searchParams.get("id") ? "read" : "status");
      const result = await handleSkillsOp(op, body, url.searchParams.get("id"));
      sendJson(response, result.status || 200, result);
    } catch (e) {
      sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  };
}

function skillRouteTail(pathname) {
  const match = String(pathname || "").match(/^\/dsh-purge\/skills?(?:\/(.*))?$/i);
  if (!match) return "";
  return String(match[1] || "").replace(/\/$/, "");
}

function installSkillsHttp(webServer) {
  // 旧版把 /dsh-purge/skills[/op] 和 /dsh-purge/skill[/op] 分别 exact 注册 10+ 条，再加 prefix 兜底；
  // handler 内部本来就按 tail 分发 op，exact 列表只是把路由表撑大，热重载还更难拆。
  // 用 2 条 prefix 覆盖全部，handler 的 forcedOp="" 让 body.op/tail/op 查询串继续生效。
  const stop = [];
  stop.push(registerRoute(webServer, {
    kind: "prefix", path: "/dsh-purge/skills", handler: skillsHttpHandler(""),
  }));
  stop.push(registerRoute(webServer, {
    kind: "prefix", path: "/dsh-purge/skill", handler: skillsHttpHandler(""),
  }));
  return () => {
    for (let i = stop.length - 1; i >= 0; i -= 1) {
      try { stop[i]?.(); } catch { /* ignore */ }
    }
  };
}

function installRulesHttp(webServer) {
  // 同 skills：prefix 一条覆盖 /dsh-purge/rules[/op]；handler 按 tail 分发 op。
  const stop = [];
  stop.push(registerRoute(webServer, {
    kind: "prefix", path: "/dsh-purge/rules", handler: rulesHttpHandler(""),
  }));
  return () => {
    for (let i = stop.length - 1; i >= 0; i -= 1) {
      try { stop[i]?.(); } catch { /* ignore */ }
    }
  };
}

async function handlePromptSnapshotsOp(op, body, queryName) {
  const dshHome = core.findDshHome();
  const name = typeof body?.name === "string" && body.name.trim()
    ? body.name.trim()
    : String(queryName || "").trim();
  if (op === "status" || op === "list") {
    return { ok: true, ...(await promptSnapshots.snapshotStatus(dshHome)) };
  }
  if (op === "save") {
    if (!name) return { status: 400, ok: false, error: "name required" };
    const saved = await promptSnapshots.saveSnapshot(dshHome, name);
    return { ok: true, ...saved };
  }
  if (op === "use" || op === "restore") {
    if (!name) return { status: 400, ok: false, error: "name required" };
    const used = await promptSnapshots.useSnapshot(dshHome, name);
    refreshHungOperator(dshHome);
    return { ok: true, ...used };
  }
  if (op === "delete") {
    if (!name) return { status: 400, ok: false, error: "name required" };
    const removed = await promptSnapshots.deleteSnapshot(dshHome, name);
    return { ok: true, ...removed };
  }
  return { status: 400, ok: false, error: `unknown op: ${op}` };
}

function promptSnapshotsHttpHandler(forcedOp) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      sendOptions(response);
      return;
    }
    // v2.2.1：非 GET/POST 一律按 GET 处理，不回 405
    try {
      const url = new URL(request.url ?? "", "http://127.0.0.1");
      const tail = String(url.pathname || "").replace(/^\/dsh-purge\/prompt-snapshots\/?/, "").replace(/\/$/, "");
      const body = request.method === "POST" ? await readJsonBody(request) : {};
      const op = forcedOp
        || body.op
        || tail
        || url.searchParams.get("op")
        || (url.searchParams.get("name") ? "status" : "status");
      const result = await handlePromptSnapshotsOp(op, body, url.searchParams.get("name"));
      sendJson(response, result.status || 200, result);
    } catch (e) {
      sendJson(response, 500, { ok: false, error: String(e && e.message ? e.message : e) });
    }
  };
}

function installPromptSnapshotsHttp(webServer) {
  const stop = [];
  stop.push(registerRoute(webServer, {
    kind: "prefix", path: "/dsh-purge/prompt-snapshots", handler: promptSnapshotsHttpHandler(""),
  }));
  return () => {
    for (let i = stop.length - 1; i >= 0; i -= 1) {
      try { stop[i]?.(); } catch { /* ignore */ }
    }
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function sendOptions(response) {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function registerRoute(webServer, spec) {
  try {
    const handler = spec.handler;
    return webServer.register({
      ...spec,
      handler: async (request, response) => {
        if (!allowPluginRequest(request, response)) return;
        return handler(request, response);
      },
    });
  } catch (e) {
    console.warn("[dsh-purge] route", spec?.path, String(e && e.message ? e.message : e));
    return () => {};
  }
}

async function readJsonBody(request, maxBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 512 * 1024;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

const plugin = {
  name,
  inject,
  apply,
};

export default plugin;
