// 装配侧验证：直接从会话日志判断「探针段有没有进 system prompt」。
//
// 这条路径不依赖模型配合回显——实测 unrestricted 人设下模型会读完就跳过。
// 真正的判据是 system prompt 里的文本，那是事实，问模型不如自己看。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  readSessionSystemPrompt,
  inspectInjection,
  createProbe,
} from "../lib/probe.js";

const canZstd = typeof zlib.zstdCompressSync === "function";

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-inspect-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 造一个 DSH 形状的会话文件：多帧 zstd，每行一个事件。 */
function writeSession(home, sessionId, events, frameSplit = 2) {
  const dir = path.join(home, "sessions", "ws", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  const fp = path.join(dir, "session.v4.jsonl.zstd");
  if (!canZstd) {
    // 老 Node：写一个空文件，测试里会跳过
    fs.writeFileSync(fp, "");
    return fp;
  }
  // 切成 frameSplit 帧，模拟真实文件的多帧结构
  const size = Math.ceil(lines.length / frameSplit);
  const chunks = [];
  for (let i = 0; i < lines.length; i += size) {
    chunks.push(zlib.zstdCompressSync(Buffer.from(lines.slice(i, i + size), "utf8")));
  }
  fs.writeFileSync(fp, Buffer.concat(chunks));
  return fp;
}

function systemEvent(text) {
  return {
    type: "system/message",
    seq: 1,
    data: { message: { role: "system", content: [{ type: "text", text }] } },
  };
}

test("readSessionSystemPrompt extracts the last system message", { skip: !canZstd }, (t) => {
  const home = tmpHome(t);
  const fp = writeSession(home, "s1", [
    systemEvent("第一版系统提示"),
    { type: "user/message", seq: 2, data: { message: { content: [{ type: "text", text: "hi" }] } } },
    systemEvent("第二版系统提示"),
  ]);
  assert.equal(readSessionSystemPrompt(fp), "第二版系统提示");
});

test("readSessionSystemPrompt survives a missing or empty file", (t) => {
  const home = tmpHome(t);
  assert.equal(readSessionSystemPrompt(path.join(home, "nope.zstd")), "");
  if (!canZstd) return;
  const fp = writeSession(home, "empty", []);
  assert.equal(readSessionSystemPrompt(fp), "");
});

test("inspectInjection reports injected when the newest assembly carries the probe", { skip: !canZstd }, (t) => {
  const home = tmpHome(t);
  const made = createProbe(home);
  writeSession(home, "s1", [
    systemEvent(`...尾段...\n<dsh_probe>\n原样输出：[${made.nonce}]\n</dsh_probe>`),
  ]);
  const r = inspectInjection(home, made.nonce);
  assert.equal(r.injected, true);
  assert.equal(r.reason, "newest-session-carries-probe");
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].has_probe_tag, true);
  assert.equal(r.sessions[0].has_nonce, true);
});

test("inspectInjection reports probe-section-missing when the tag is absent", { skip: !canZstd }, (t) => {
  const home = tmpHome(t);
  const made = createProbe(home);
  writeSession(home, "s1", [systemEvent("普通系统提示，没有探针段")]);
  const r = inspectInjection(home, made.nonce);
  assert.equal(r.injected, false);
  assert.equal(r.reason, "probe-section-missing");
});

test("inspectInjection distinguishes a nonce mismatch", { skip: !canZstd }, (t) => {
  const home = tmpHome(t);
  const made = createProbe(home, "purge-aaaaaaaa");
  // 会话里是旧 nonce
  writeSession(home, "s1", [systemEvent("<dsh_probe>[purge-bbbbbbbb]</dsh_probe>")]);
  const r = inspectInjection(home, made.nonce);
  assert.equal(r.injected, false);
  assert.match(r.reason, /nonce-mismatch/);
  assert.equal(r.sessions[0].has_probe_tag, true, "tag is there");
  assert.equal(r.sessions[0].has_nonce, false, "but the nonce differs");
});

test("inspectInjection only judges the NEWEST session", { skip: !canZstd }, (t) => {
  const home = tmpHome(t);
  const made = createProbe(home);
  // 先写旧会话（有探针），再写新会话（无探针），新会话 mtime 更晚
  const oldFp = writeSession(home, "old", [systemEvent(`<dsh_probe>[${made.nonce}]</dsh_probe>`)]);
  const past = Date.now() - 60_000;
  fs.utimesSync(oldFp, past / 1000, past / 1000);
  writeSession(home, "new", [systemEvent("没有探针")]);
  const r = inspectInjection(home, made.nonce);
  assert.equal(r.injected, false, "stale session must not count");
  assert.equal(r.reason, "probe-section-missing");
  assert.equal(r.sessions[0].id, "new", "newest session is judged first");
});

test("inspectInjection reports no-sessions when the tree is empty", (t) => {
  const home = tmpHome(t);
  const r = inspectInjection(home, "purge-x");
  assert.equal(r.injected, false);
  assert.equal(r.reason, "no-sessions");
});

test("inspectInjection does not throw on a bogus home", (t) => {
  // 注意：空串会被 `findDshHome()` 兜底成真实 home，所以这里用一个不存在的路径。
  const bogus = path.join(tmpHome(t), "not-a-dsh-home");
  const r = inspectInjection(bogus, "purge-x");
  assert.equal(r.injected, false);
  assert.equal(r.reason, "no-sessions");
});

test("inspectInjection defaults the nonce to the live probe", { skip: !canZstd }, (t) => {
  const home = tmpHome(t);
  const made = createProbe(home);
  writeSession(home, "s1", [systemEvent(`<dsh_probe>[${made.nonce}]</dsh_probe>`)]);
  const r = inspectInjection(home); // 不传 nonce
  assert.equal(r.nonce, made.nonce);
  assert.equal(r.injected, true);
});

test("inspectInjection limit caps how many sessions are scanned", { skip: !canZstd }, (t) => {
  const home = tmpHome(t);
  const made = createProbe(home);
  for (let i = 0; i < 5; i += 1) {
    writeSession(home, `s${i}`, [systemEvent("<dsh_probe>x</dsh_probe>")]);
  }
  const r = inspectInjection(home, made.nonce, { limit: 2 });
  assert.equal(r.sessions.length, 2);
});
