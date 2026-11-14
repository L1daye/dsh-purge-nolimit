// 运行时探针：证明"注入真的到达了模型"。
//
// 探针本身很容易写错的两件事：TTL 到期后必须自动失效（否则长期占 token），
// 以及 probeText 在无探针时必须返回空串（否则每轮都塞一段没用的文本）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROBE_TTL_MS,
  PROBE_SECTION,
  PROBE_ORDER,
  probePath,
  createProbe,
  readProbe,
  clearProbe,
  probeText,
  probeMessage,
  probeHit,
} from "../lib/probe.js";

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("createProbe writes a nonce and returns a ready-to-paste message", (t) => {
  const home = tmpHome(t);
  const made = createProbe(home);
  assert.match(made.nonce, /^purge-[0-9a-f]{8}$/);
  assert.ok(fs.existsSync(probePath(home)));
  assert.ok(made.message.includes(`[${made.nonce}]`));
});

test("readProbe round-trips the nonce", (t) => {
  const home = tmpHome(t);
  const made = createProbe(home);
  const live = readProbe(home);
  assert.equal(live.nonce, made.nonce);
  assert.ok(live.ageMs >= 0);
});

test("createProbe accepts a custom nonce", (t) => {
  const home = tmpHome(t);
  const made = createProbe(home, "purge-deadbeef");
  assert.equal(made.nonce, "purge-deadbeef");
  assert.equal(readProbe(home).nonce, "purge-deadbeef");
});

test("probeText carries the nonce and is empty without a probe", (t) => {
  const home = tmpHome(t);
  assert.equal(probeText(home), "", "no probe -> no section text");

  const made = createProbe(home);
  const text = probeText(home);
  assert.ok(text.includes("<dsh_probe>"));
  assert.ok(text.includes(made.nonce));
  assert.ok(text.includes("</dsh_probe>"));
});

test("probeText disappears after clearProbe", (t) => {
  const home = tmpHome(t);
  createProbe(home);
  assert.notEqual(probeText(home), "");
  clearProbe(home);
  assert.equal(probeText(home), "");
  assert.equal(readProbe(home), null);
});

test("an expired probe is dropped and its text stops appearing", (t) => {
  const home = tmpHome(t);
  const made = createProbe(home);
  // 手改 at 伪造过期（不 sleep 30 分钟）
  const fp = probePath(home);
  const data = JSON.parse(fs.readFileSync(fp, "utf8"));
  data.at = made.at - PROBE_TTL_MS - 1000;
  fs.writeFileSync(fp, JSON.stringify(data), "utf8");

  assert.equal(readProbe(home), null, "expired probe must not be returned");
  assert.equal(probeText(home), "", "expired probe must not inject");
  assert.equal(fs.existsSync(fp), false, "expired probe file should be cleaned up");
});

test("a corrupt probe file is treated as absent, not as an error", (t) => {
  const home = tmpHome(t);
  const fp = probePath(home);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, "{not json", "utf8");
  assert.equal(readProbe(home), null);
  assert.equal(probeText(home), "");
});

test("probeHit recognises the echo", () => {
  assert.equal(probeHit("好的\n[purge-1a2b3c4d]", "purge-1a2b3c4d"), true);
  assert.equal(probeHit("[purge-1a2b3c4d] 已回显", "purge-1a2b3c4d"), true);
  assert.equal(probeHit("purge-1a2b3c4d", "purge-1a2b3c4d"), true, "bare nonce also counts");
  assert.equal(probeHit("完全无关的回答", "purge-1a2b3c4d"), false);
  assert.equal(probeHit("", "purge-1a2b3c4d"), false);
  assert.equal(probeHit("[x]", ""), false);
});

test("probeMessage is stable for the same nonce", () => {
  const a = probeMessage("purge-aaaaaaaa");
  const b = probeMessage("purge-aaaaaaaa");
  assert.equal(a, b);
  assert.notEqual(a, probeMessage("purge-bbbbbbbb"));
});

test("section name and order are stable", () => {
  // 这两个值被 index.js 的 section 注册和排查脚本引用，不能随便改。
  assert.equal(PROBE_SECTION, "dsh-purge:probe");
  assert.equal(PROBE_ORDER, 9000);
});

test("createProbe overwrites an existing probe", (t) => {
  const home = tmpHome(t);
  const first = createProbe(home);
  const second = createProbe(home);
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(readProbe(home).nonce, second.nonce);
});

test("clearProbe on a missing file is not an error", (t) => {
  const home = tmpHome(t);
  const r = clearProbe(home);
  assert.equal(typeof r.cleared, "boolean");
});
