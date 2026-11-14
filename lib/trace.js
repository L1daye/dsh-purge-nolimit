/**
 * 破甲时间线 / Armor timeline.
 *
 * index.js 里有一个一直开着的内部日志探针（PURGE_INTERNAL_LOG），每轮装配都写：
 *   assemble.entry   —— 请求到没到我们的 handler、下游有没有 next
 *   inject.read      —— 这一轮注入正文从哪一层拿到、多少字节
 *   assemble.rewrite —— 装配改写结果：段数、首段是不是我们、闭合标签后剩多少
 *   host.hungFn      —— host 兜底走了四重 fallback 的哪一层、有没有走到空
 *   guard.wrap       —— 代理层包没包上
 *   assemble.waterfall / assemble.rewriteFail —— 下游抛错
 *
 * 这些信息现在只能靠人 `tail -F` + grep。这里把它变成可查询的时间线：
 * 按轮聚合，标出塌陷轮，回答「最近这些轮里，破甲是在哪一层丢的」。
 *
 * 只读日志文件，不改插件状态。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 与 index.js 的 PURGE_INTERNAL_LOG 同一路径；index 会把自己的值传进来覆盖。 */
export const DEFAULT_LOG = path.join(os.tmpdir(), "dsh-purge-desktop.log");

/** 只读末尾这么多字节。日志翻滚上限 2MB，读 4MB 足够覆盖一轮完整历史。 */
const TAIL_BYTES = 4 << 20;

const LINE = /^(\S+)\s+\[([^\]]+)\]\s*(.*)$/;

function parseKv(rest) {
  const kv = {};
  const text = String(rest || "").trim();
  if (!text) return kv;
  for (const part of text.split(/\s+/)) {
    const at = part.indexOf("=");
    if (at <= 0) {
      kv._ = kv._ ? `${kv._} ${part}` : part;
      continue;
    }
    kv[part.slice(0, at)] = part.slice(at + 1);
  }
  return kv;
}

function toNum(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 从文件尾部读，避免整文件载入。日志虽有 2MB 翻滚，但 .1 备份可能更大。
 * @returns {{ text: string, truncated: boolean, bytes: number }}
 */
export function readLogTail(logPath = DEFAULT_LOG, maxBytes = TAIL_BYTES) {
  let fd;
  try {
    const st = fs.statSync(logPath);
    if (!st.isFile() || st.size === 0) return { text: "", truncated: false, bytes: 0 };
    const start = Math.max(0, st.size - maxBytes);
    fd = fs.openSync(logPath, "r");
    const length = st.size - start;
    const buf = Buffer.allocUnsafe(length);
    const read = fs.readSync(fd, buf, 0, length, start);
    let text = buf.subarray(0, read).toString("utf8");
    // 从中间切进去时，第一行必然是半截，丢掉。
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return { text, truncated: start > 0, bytes: st.size };
  } catch {
    return { text: "", truncated: false, bytes: 0 };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/** 把日志文本切成结构化条目。 */
export function parseLines(text) {
  const events = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (!raw) continue;
    const m = LINE.exec(raw);
    if (!m) continue;
    events.push({ at: m[1], tag: m[2], kv: parseKv(m[3]) });
  }
  return events;
}

const TURN_TAGS = new Set([
  "assemble.entry",
  "assemble.rewrite",
  "assemble.waterfall",
  "assemble.rewriteFail",
  "inject.read",
  "host.hungFn",
]);

/**
 * 按轮聚合。assemble.entry 开启一轮，后续 inject.read / assemble.rewrite 归入。
 *
 * @param {Array<object>} events
 * @returns {Array<object>} 轮列表（旧在前）
 */
export function buildTurns(events) {
  const turns = [];
  let current = null;

  const open = (event) => {
    current = {
      at: event.at,
      entry: null,
      inject: null,
      rewrite: null,
      hung: [],
      failures: [],
      // 判定用
      collapsed: false,
      headMiss: false,
      afterCloser: null,
    };
    turns.push(current);
  };

  for (const event of events) {
    const isTurnStart = event.tag === "assemble.entry";
    if (isTurnStart) {
      open(event);
      current.entry = event.kv;
      continue;
    }
    if (!TURN_TAGS.has(event.tag)) continue;
    // 首轮之前可能有孤立的 host.hungFn（启动预热），单独挂一个匿名轮。
    if (!current) open(event);

    if (event.tag === "inject.read") {
      current.inject = event.kv;
      const source = String(event.kv.source || "");
      const out = toNum(event.kv.outBytes) || 0;
      if (source === "empty" || out === 0) current.collapsed = true;
      continue;
    }
    if (event.tag === "assemble.rewrite") {
      current.rewrite = event.kv;
      const injectBytes = toNum(event.kv.injectBytes) || 0;
      if (injectBytes === 0) current.collapsed = true;
      if (event.kv.injectHead === "false") current.headMiss = true;
      const after = toNum(event.kv.afterCloser);
      current.afterCloser = after;
      continue;
    }
    if (event.tag === "host.hungFn") {
      current.hung.push(event.kv);
      if (String(event.kv.tier || "") === "empty") current.collapsed = true;
      continue;
    }
    if (event.tag === "assemble.waterfall" || event.tag === "assemble.rewriteFail") {
      current.failures.push({ tag: event.tag, ...event.kv });
    }
  }

  return turns;
}

/**
 * 汇总最近窗口。
 *
 * @param {{ logPath?: string, window?: number }} [options]
 */
export function analyzeTimeline(options = {}) {
  const logPath = options.logPath || DEFAULT_LOG;
  const windowSize = Number.isFinite(options.window) ? Math.max(1, Math.trunc(options.window)) : 20;

  const tail = readLogTail(logPath);
  if (!tail.text) {
    return {
      ok: false,
      reason: "no_log",
      log_path: logPath,
      turns: [],
      recent: [],
      totals: {},
      window: 0,
      notes: ["内部日志不存在或为空：进程还没写过一轮装配，或日志被清理了。"],
    };
  }

  const events = parseLines(tail.text);
  const turns = buildTurns(events);
  const recent = turns.slice(Math.max(0, turns.length - windowSize));

  const totals = {
    turns: turns.length,
    collapsed: 0,
    headMiss: 0,
    afterCloser: 0,
    failures: 0,
    hungEmpty: 0,
  };
  const tiers = {};
  for (const t of recent) {
    if (t.collapsed) totals.collapsed += 1;
    if (t.headMiss) totals.headMiss += 1;
    if (typeof t.afterCloser === "number" && t.afterCloser > 2) totals.afterCloser += 1;
    if (t.failures.length) totals.failures += t.failures.length;
    for (const h of t.hung) {
      if (String(h.tier || "") === "empty") totals.hungEmpty += 1;
    }
    const source = String(t.inject?.source || "");
    if (source) tiers[source] = (tiers[source] || 0) + 1;
  }

  const notes = [];
  if (totals.collapsed > 0) {
    notes.push(`${totals.collapsed}/${recent.length} 轮出现空注入：四重 fallback 有塌陷。`);
  }
  if (totals.hungEmpty > 0) {
    notes.push(`host 兜底走到空 ${totals.hungEmpty} 次：加密槽解包也可能失败了。`);
  }
  if (totals.failures > 0) {
    notes.push(`下游装配抛错 ${totals.failures} 次：已用上游装配兜底，但那一轮可能没注入。`);
  }
  if (totals.headMiss > 0) {
    notes.push(`${totals.headMiss} 轮首段不是 dsh-purge：注入被宿主段盖到后面。`);
  }

  return {
    ok: true,
    log_path: logPath,
    log_bytes: tail.bytes,
    truncated: tail.truncated,
    turns,
    recent,
    totals,
    tiers,
    window: recent.length,
    notes,
  };
}

function fmtBytes(value) {
  return Number.isFinite(value) ? `${value} B` : "?";
}

export function renderTimeline(result) {
  const out = [];
  if (!result.ok) {
    out.push(`破甲时间线 / Timeline — ${result.reason === "no_log" ? "无日志" : "读取失败"}`);
    out.push(`  ${result.log_path}`);
    for (const note of result.notes || []) out.push(`  ${note}`);
    return out.join("\n");
  }

  out.push(`破甲时间线 / Timeline — 最近 ${result.window}/${result.totals.turns} 轮`);
  out.push(`  日志: ${result.log_path}（${result.log_bytes} B${result.truncated ? "，已读尾部" : ""}）`);
  const t = result.totals;
  out.push(`  塌陷 ${t.collapsed} · 首段丢失 ${t.headMiss} · 尾部被包 ${t.afterCloser} · 下游抛错 ${t.failures}`);
  const tiers = Object.entries(result.tiers || {});
  if (tiers.length) out.push(`  注入来源: ${tiers.map(([k, v]) => `${k}×${v}`).join(", ")}`);

  if (result.recent.length) {
    out.push("");
    out.push("  轮次 / turns:");
    for (const turn of result.recent) {
      const flags = [];
      if (turn.collapsed) flags.push("空注入");
      if (turn.headMiss) flags.push("首段丢失");
      if (turn.failures.length) flags.push(`抛错×${turn.failures.length}`);
      const source = String(turn.inject?.source || "-");
      const outBytes = toNum(turn.inject?.outBytes);
      const injectBytes = toNum(turn.rewrite?.injectBytes);
      const bytes = injectBytes ?? outBytes;
      const mark = flags.length ? "!" : "·";
      out.push(`    ${mark} ${turn.at}  来源=${source}  注入=${fmtBytes(bytes)}${flags.length ? `  [${flags.join(", ")}]` : ""}`);
    }
  }

  if (result.notes.length) {
    out.push("");
    for (const note of result.notes) out.push(`  ${note}`);
  }
  return out.join("\n");
}
