// 原子写入：权限保持、临时文件清理、并发唯一名、durable。
//
// issue #20 的实际事故：复制一个 0600 的私有配置，落地后变成 0644；
// 复制一个 0755 的启动器，丢了执行位。原实现只对 atomicWrite 系列保留权限，
// atomicCopyFile 系列没有 chmod —— 复制即丢权限。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteSync,
  atomicWriteFile,
  atomicCopyFileSync,
  atomicCopyFile,
} from "../lib/core.js";

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-atomic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function leftovers(dir) {
  return fs.readdirSync(dir).filter((n) => n.includes(".tmp") || n.includes(".copytmp"));
}

test("atomicWriteSync writes content and leaves no temp file", (t) => {
  const dir = tmpdir(t);
  const fp = path.join(dir, "a.json");
  atomicWriteSync(fp, '{"x":1}');
  assert.equal(fs.readFileSync(fp, "utf8"), '{"x":1}');
  assert.deepEqual(leftovers(dir), []);
});

test("atomicWriteSync keeps the existing mode of a private file", (t) => {
  const dir = tmpdir(t);
  const fp = path.join(dir, "secret.json");
  fs.writeFileSync(fp, "old");
  // 0600 = 只有属主可读写。Windows 只体现只读位，所以这里比较「写入前后一致」，
  // 而不是断言某个具体数值——跨平台更稳，也正好是 issue #20 的判据。
  try { fs.chmodSync(fp, 0o600); } catch { /* Windows 上可能不支持 */ }
  const before = fs.statSync(fp).mode & 0o777;
  atomicWriteSync(fp, "new");
  const after = fs.statSync(fp).mode & 0o777;
  assert.equal(after, before, "mode must survive the rewrite");
  assert.equal(fs.readFileSync(fp, "utf8"), "new");
});

test("atomicWriteSync applies options.mode for a brand-new file", (t) => {
  const dir = tmpdir(t);
  const fp = path.join(dir, "exec.sh");
  atomicWriteSync(fp, "#!/bin/sh\n", "utf8", { mode: 0o755 });
  const mode = fs.statSync(fp).mode & 0o777;
  // POSIX 上应当拿到 0755；Windows 上至少不该是 0
  assert.ok(mode !== 0);
  if (process.platform !== "win32") assert.equal(mode, 0o755);
});

test("atomicWriteSync with durable fsyncs the content", (t) => {
  const dir = tmpdir(t);
  const fp = path.join(dir, "d.json");
  atomicWriteSync(fp, "durable", "utf8", { durable: true });
  assert.equal(fs.readFileSync(fp, "utf8"), "durable");
  assert.deepEqual(leftovers(dir), []);
});

test("atomicWriteFile (async) writes and cleans up", async (t) => {
  const dir = tmpdir(t);
  const fp = path.join(dir, "b.json");
  await atomicWriteFile(fp, "async");
  assert.equal(fs.readFileSync(fp, "utf8"), "async");
  assert.deepEqual(leftovers(dir), []);
});

test("atomicCopyFileSync preserves the SOURCE mode (issue #20)", (t) => {
  const dir = tmpdir(t);
  const src = path.join(dir, "src.sh");
  const dst = path.join(dir, "dst.sh");
  fs.writeFileSync(src, "#!/bin/sh\necho hi\n");
  try { fs.chmodSync(src, 0o755); } catch { /* Windows */ }
  const srcMode = fs.statSync(src).mode & 0o777;
  atomicCopyFileSync(src, dst);
  const dstMode = fs.statSync(dst).mode & 0o777;
  assert.equal(dstMode, srcMode, "copy must not widen or drop permissions");
  assert.equal(fs.readFileSync(dst, "utf8"), "#!/bin/sh\necho hi\n");
  assert.deepEqual(leftovers(dir), []);
});

test("atomicCopyFile (async) preserves the source mode", async (t) => {
  const dir = tmpdir(t);
  const src = path.join(dir, "a.bin");
  const dst = path.join(dir, "b.bin");
  fs.writeFileSync(src, Buffer.from([1, 2, 3]));
  try { fs.chmodSync(src, 0o600); } catch { /* Windows */ }
  const srcMode = fs.statSync(src).mode & 0o777;
  await atomicCopyFile(src, dst);
  assert.equal(fs.statSync(dst).mode & 0o777, srcMode);
  assert.deepEqual([...fs.readFileSync(dst)], [1, 2, 3]);
});

test("temp names are unique across concurrent writes to the same target", async (t) => {
  const dir = tmpdir(t);
  const fp = path.join(dir, "race.json");
  // 同时写 20 次同一路径：只要临时名会撞，就一定有输家抛 ENOENT/EEXIST。
  const jobs = [];
  for (let i = 0; i < 20; i += 1) jobs.push(atomicWriteFile(fp, `v${i}`));
  await Promise.all(jobs);
  const final = fs.readFileSync(fp, "utf8");
  assert.ok(/^v\d+$/.test(final), "one of the writers must win cleanly");
  assert.deepEqual(leftovers(dir), [], "no temp files may be left behind");
});

test("a failing write does not leave a temp file behind", (t) => {
  const dir = tmpdir(t);
  // 目标是目录 → rename 必然失败
  const target = path.join(dir, "adir");
  fs.mkdirSync(target);
  assert.throws(() => atomicWriteSync(target, "x"));
  assert.deepEqual(leftovers(dir), []);
});

test("overwriting keeps file readable and complete", (t) => {
  const dir = tmpdir(t);
  const fp = path.join(dir, "big.txt");
  const big = "x".repeat(200 * 1024);
  fs.writeFileSync(fp, "small");
  atomicWriteSync(fp, big);
  assert.equal(fs.statSync(fp).size, big.length);
  assert.equal(fs.readFileSync(fp, "utf8"), big);
});
