/**
 * 运行时探针：证明"注入真的到达了模型"。
 *
 * 为什么需要它：补丁写进磁盘、section 注册成功，只能证明**宿主侧就绪**。
 * 真正的链路是 磁盘 → 装配 → 模型收到。中间任何一环断了，界面看起来都正常。
 *
 * 做法：写一个一次性 nonce，在系统提示词尾部挂一段"看到就原样回显"的短指令。
 * 模型回显 = 这条链路真的通了。30 分钟自动过期，不长期占 token。
 *
 * 与社区版的差异：他们同时依赖 `tuning.js` 做开关，我们用独立的 `probe.json`，
 * 少一层耦合；写入走 core 的原子写，避免面板并发读时读到半份 JSON。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { randomBytes } from "node:crypto";
import { findDshHome, atomicWriteSync } from "./core.js";

export const PROBE_SECTION = "dsh-purge:probe";
export const PROBE_TTL_MS = 30 * 60 * 1000;
/** 放在注入正文和 postPrompt 之后：尾部指令在长上下文里更稳，也更容易被回显。 */
export const PROBE_ORDER = 9000;

export function probePath(dshHome) {
  const home = dshHome || findDshHome();
  if (!home) return "";
  return path.join(home, "dsh-purge", "probe.json");
}

function readRaw(dshHome) {
  const file = probePath(dshHome);
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data.nonce !== "string" || !data.nonce) return null;
    return data;
  } catch {
    return null;
  }
}

/** 读探针；过期就顺手删掉并返回 null。 */
export function readProbe(dshHome) {
  const data = readRaw(dshHome);
  if (!data) return null;
  const at = Number(data.at) || 0;
  if (!at || Date.now() - at > PROBE_TTL_MS) {
    clearProbe(dshHome);
    return null;
  }
  return { nonce: data.nonce, at, ageMs: Date.now() - at };
}

/** 生成新探针（旧的直接覆盖）。 */
export function createProbe(dshHome, nonce) {
  const file = probePath(dshHome);
  if (!file) throw new Error("未定位 DSH 数据目录，无法写探针");
  const value = typeof nonce === "string" && nonce.trim()
    ? nonce.trim()
    : `purge-${randomBytes(4).toString("hex")}`;
  const at = Date.now();
  atomicWriteSync(file, `${JSON.stringify({ nonce: value, at }, null, 2)}\n`, "utf8", { mode: 0o600 });
  return { nonce: value, at, ttlMs: PROBE_TTL_MS, message: probeMessage(value) };
}

export function clearProbe(dshHome) {
  const file = probePath(dshHome);
  if (!file) return { cleared: false };
  try {
    fs.rmSync(file, { force: true });
    return { cleared: true };
  } catch {
    return { cleared: false };
  }
}

/** 给操作者照着发的一句话。 */
export function probeMessage(nonce) {
  return [
    "请原样输出下面这行（不要改写、不要解释）：",
    `[${nonce}]`,
    "",
    "看到它原样出现在回复里，就说明 dsh-purge 的注入确实到达了模型上下文。",
  ].join("\n");
}

/** 探针存活时注入的段落正文；过期或不存在返回空串（= 该段不出现）。 */
export function probeText(dshHome) {
  const probe = readProbe(dshHome);
  if (!probe) return "";
  return [
    "<dsh_probe>",
    "这条系统提示词由 dsh-purge 写入，用于验证注入链路是否到达模型。",
    `如果本段在你的上下文里，请在回复的最后单独一行原样输出：[${probe.nonce}]`,
    "</dsh_probe>",
  ].join("\n");
}

/** 校验回显：模型回复里有没有那个 nonce。 */
export function probeHit(text, nonce) {
  if (!text || !nonce) return false;
  return String(text).includes(`[${nonce}]`) || String(text).includes(nonce);
}

// ── 装配侧验证（不依赖模型配合）──
//
// 探针的「模型回显」只是好看：模型完全可能读完指令就当噪音跳过
// （实测 unrestricted 人设下就这样）。真正要证明的是
// **这段文本有没有进 system prompt**，而那件事在会话日志里是事实，
// 不需要问模型。
//
// 会话日志 ~/.dsh/sessions/<ws>/<id>/session.v4.jsonl.zstd 是 zstd 多帧，
// 按 MAGIC 切帧逐段解压；system/message 事件里就是模型那一轮看到的全文。

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 单次检查最多读几个会话：够判断"最新装配里有没有"，又不至于扫整个目录。 */
const INSPECT_LIMIT = 3;
/**
 * 单个会话文件的大小上限。
 *
 * 实测：一个跑了 2400 步的长会话是 12.8 MB（解压后 38 MB）。原来的 8 MB
 * 上限会把它整份跳过、返回空串，于是 `injected=false` —— 报"没注入"而
 * 实际上注入是好的。这类**假阴性**比漏报更危险，所以上限给足。
 */
const INSPECT_MAX_BYTES = 128 * 1024 * 1024;

function sessionsRoot(dshHome) {
  const home = dshHome || findDshHome();
  return home ? path.join(home, "sessions") : "";
}

function listSessionFiles(root, limit) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith(".zstd")) continue;
      try {
        const st = fs.statSync(p);
        out.push({ path: p, mtime: st.mtimeMs, size: st.size, id: path.basename(dir) });
      } catch { /* 文件刚好被轮转 */ }
    }
  };
  walk(root);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function decodeZstdFrames(buf) {
  let text = "";
  let pos = 0;
  while (pos < buf.length) {
    const next = buf.indexOf(ZSTD_MAGIC, pos + 1);
    const end = next === -1 ? buf.length : next;
    try {
      text += zlib.zstdDecompressSync(buf.subarray(pos, end)).toString("utf8");
    } catch { /* 坏帧跳过，能解多少算多少 */ }
    if (next === -1) break;
    pos = next;
  }
  return text;
}

/**
 * 读一个会话里**最后一条** system/message 的正文。
 * 找不到返回空串。
 *
 * 从后往前扫而不是 split 整份：长会话解压后有几十 MB、上百万行，
 * split 一次就是几百万个字符串。这里只需要最后那条 system/message，
 * 用 lastIndexOf 定位再逐条往回退，代价是常数级。
 */
export function readSessionSystemPrompt(file) {
  let buf;
  try {
    const st = fs.statSync(file);
    if (st.size > INSPECT_MAX_BYTES) return "";
    buf = fs.readFileSync(file);
  } catch {
    return "";
  }
  const text = decodeZstdFrames(buf);
  if (!text) return "";

  let from = text.lastIndexOf('"system/message"');
  let guard = 0;
  while (from >= 0 && guard < 50) {
    guard += 1;
    const lineStart = text.lastIndexOf("\n", from) + 1;
    const nl = text.indexOf("\n", from);
    const line = text.slice(lineStart, nl === -1 ? text.length : nl);
    if (line.trim()) {
      try {
        const event = JSON.parse(line);
        if (event?.type === "system/message") {
          const blocks = event.data?.message?.content ?? event.data?.content ?? [];
          const body = Array.isArray(blocks)
            ? blocks.filter((b) => b && b.type === "text").map((b) => String(b.text || "")).join("")
            : String(event.data?.text || "");
          if (body) return body;
        }
      } catch { /* 这一行不是完整 JSON，往回退一条 */ }
    }
    from = text.lastIndexOf('"system/message"', from - 1);
  }
  return "";
}

/**
 * 检查最近的装配里有没有探针段。
 *
 * @returns `{ injected, nonce, sessions: [...], root, reason }`
 *   `injected=true` 表示**最新**那个会话的系统提示里既有 `<dsh_probe>` 也有当前 nonce。
 */
export function inspectInjection(dshHome, nonce, options = {}) {
  const home = dshHome || findDshHome();
  const root = sessionsRoot(home);
  const want = nonce || readProbe(home)?.nonce || "";
  if (!root) return { injected: false, nonce: want, sessions: [], root: "", reason: "no-dsh-home" };
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(10, options.limit)) : INSPECT_LIMIT;
  const files = listSessionFiles(root, limit);
  if (files.length === 0) {
    return { injected: false, nonce: want, sessions: [], root, reason: "no-sessions" };
  }
  const sessions = [];
  for (const f of files) {
    const sys = readSessionSystemPrompt(f.path);
    const hasProbeTag = sys.includes("<dsh_probe>");
    const hasNonce = want ? sys.includes(want) : false;
    sessions.push({
      id: f.id,
      mtime: new Date(f.mtime).toISOString(),
      system_bytes: sys.length,
      has_probe_tag: hasProbeTag,
      has_nonce: hasNonce,
    });
  }
  // 只看最新那个：旧会话可能是探针创建之前的装配，拿它判断会误报。
  const newest = sessions[0];
  const injected = Boolean(newest && newest.has_probe_tag && newest.has_nonce);
  return {
    injected,
    nonce: want,
    sessions,
    root,
    reason: injected
      ? "newest-session-carries-probe"
      : newest && !newest.has_probe_tag
        ? "probe-section-missing"
        : newest && newest.has_probe_tag && !newest.has_nonce
          ? "nonce-mismatch (probe recreated after this assembly)"
          : "unknown",
  };
}
