/**
 * Session tools — export current session transcript to a markdown file and
 * report session stats (message count, role breakdown, rough token estimate).
 * Reads the live session through the host `sessions` service when available,
 * falling back to sessionController / sessionQuery the same way rewind does.
 */
import fs, { promises as fsp } from "node:fs";
import path from "node:path";

function service(ctx, name) {
  if (!ctx || typeof ctx.get !== "function") return undefined;
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

function asEventList(events) {
  if (Array.isArray(events)) return events;
  if (events && typeof events[Symbol.iterator] === "function") {
    try {
      return [...events];
    } catch {
      return [];
    }
  }
  return [];
}

function disposeObservation(observed) {
  try {
    observed?.[Symbol.dispose]?.();
  } catch {
    /* ignore */
  }
}

export async function readSessionLog(ctx, sessionId) {
  if (!sessionId) throw new Error("No active session");
  const store = service(ctx, "sessions");
  const live = store?.get?.(sessionId);
  if (live?.snapshotEvents) {
    return {
      events: asEventList(live.snapshotEvents()),
      header: live.header,
      cwd: live.header?.cwd,
    };
  }
  const controller = service(ctx, "sessionController");
  if (typeof controller?.inspect === "function") {
    const inspected = await controller.inspect(sessionId);
    return {
      events: asEventList(inspected?.events),
      header: inspected?.meta || inspected?.header,
      cwd: inspected?.meta?.cwd || inspected?.header?.cwd,
    };
  }
  const query = service(ctx, "sessionQuery");
  if (typeof query?.observeSession === "function") {
    const observed = await query.observeSession(sessionId, { projectionMode: "none" });
    try {
      return {
        events: asEventList(observed?.events),
        header: observed?.header,
        cwd: observed?.header?.cwd,
      };
    } finally {
      disposeObservation(observed);
    }
  }
  throw new Error("Cannot find the current session");
}

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block.type === "text" || typeof block.text === "string") {
      parts.push(String(block.text ?? ""));
    }
  }
  return parts.join("");
}

function messageRole(event) {
  const type = String(event?.type || "");
  if (type === "user/message") return "user";
  if (type === "assistant/message" || type === "assistant/message/stream") return "assistant";
  if (type === "tool/call") return "tool";
  return "";
}

function estimateTokens(text) {
  // CJK roughly 1 token per char, latin roughly 4 chars per token.
  const cjk = (String(text || "").match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const rest = Math.max(0, String(text || "").length - cjk);
  return Math.ceil(cjk + rest / 4);
}

export function sessionStatsFromLog(log) {
  const events = asEventList(log?.events);
  const counts = { user: 0, assistant: 0, tool: 0, other: 0 };
  let chars = 0;
  let toolCalls = 0;
  let turns = 0;
  let contentTokens = 0;
  const lastTextByRole = { user: "", assistant: "" };
  for (const event of events) {
    const type = String(event?.type || "");
    if (type === "turn/start") turns += 1;
    if (type === "tool/call") toolCalls += 1;
    const role = messageRole(event);
    if (!role) {
      counts.other += 1;
      continue;
    }
    counts[role] += 1;
    const text = blockText(event?.data?.content ?? event?.data?.message?.content ?? "");
    chars += text.length;
    contentTokens += estimateTokens(text);
    // tool 调用参数也计入 token（与真实上下文开销一致）
    if (role === "tool") {
      try {
        const argsBlob = JSON.stringify(event?.data?.input ?? event?.data?.arguments ?? event?.data ?? "");
        contentTokens += estimateTokens(argsBlob);
      } catch { /* 循环引用等无法序列化时跳过 */ }
    }
    if (text.trim()) lastTextByRole[role] = text.trim().slice(0, 160);
  }
  return {
    events: events.length,
    turns,
    messages: counts.user + counts.assistant + counts.tool,
    user_messages: counts.user,
    assistant_messages: counts.assistant,
    tool_calls: toolCalls,
    chars,
    approx_tokens: contentTokens,
    last_user_preview: lastTextByRole.user,
    last_assistant_preview: lastTextByRole.assistant,
  };
}

export function transcriptMarkdown(log, options = {}) {
  const events = asEventList(log?.events);
  const lines = [];
  lines.push("# dsh-purge 会话导出 / Session Export");
  lines.push("");
  const cwd = log?.cwd || log?.header?.cwd || "";
  const title = log?.header?.title || log?.header?.name || log?.header?.id || "";
  lines.push(`- 导出时间 / exported: ${new Date().toISOString()}`);
  if (title) lines.push(`- 会话 / session: ${title}`);
  if (cwd) lines.push(`- 工作目录 / cwd: ${cwd}`);
  lines.push(`- 事件数 / events: ${events.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");
  for (const event of events) {
    const type = String(event?.type || "");
    const role = messageRole(event);
    if (!role) continue;
    const data = event?.data || {};
    const text = blockText(data.content ?? data.message?.content ?? "");
    if (!text.trim()) continue;
    const label = role === "user" ? "🧑 用户" : role === "assistant" ? "🤖 助手" : "🔧 工具";
    lines.push(`## ${label}`);
    lines.push("");
    lines.push("```text");
    lines.push(text.replace(/\r\n/g, "\n").trim());
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

export async function exportSessionToFile(ctx, sessionId, filePath = "") {
  const log = await readSessionLog(ctx, sessionId);
  const md = transcriptMarkdown(log);
  let target = String(filePath || "").trim();
  if (!target) {
    const cwd = log?.cwd || log?.header?.cwd || process.cwd();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    target = path.join(cwd, `dsh-session-export-${stamp}.md`);
  } else if (!path.isAbsolute(target)) {
    const cwd = log?.cwd || log?.header?.cwd || process.cwd();
    target = path.join(cwd, target);
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, md, "utf8");
  const stat = await fsp.stat(target);
  return {
    path: target,
    bytes: stat.size,
    chars: md.length,
    lines: md.split("\n").length,
  };
}

export async function sessionStats(ctx, sessionId) {
  const log = await readSessionLog(ctx, sessionId);
  return sessionStatsFromLog(log);
}

export function renderSessionStats(st) {
  return [
    "会话统计 / Session Stats",
    `  事件 / events: ${st.events}`,
    `  轮次 / turns: ${st.turns}`,
    `  消息 / messages: ${st.messages}（用户 ${st.user_messages} · 助手 ${st.assistant_messages} · 工具调用 ${st.tool_calls}）`,
    `  字符 / chars: ${st.chars}`,
    `  近似 token: ${st.approx_tokens}`,
    st.last_user_preview ? `  最后用户输入: ${st.last_user_preview}` : "",
    st.last_assistant_preview ? `  最后助手输出: ${st.last_assistant_preview}` : "",
  ].filter(Boolean).join("\n");
}
