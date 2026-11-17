// redteam 的 node:sqlite 依赖必须在缺失时给出可行动的报错。
//
// 事故：远程探针枚举 redteam 模块，7 个直接 import 失败，报的是
//   Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
// 看不出「要什么版本」「为什么宿主里没事」。真相是系统 node v20.14.0 没有
// node:sqlite，而宿主 Electron 44 自带 Node 24.21.0 有——同一份代码两个结论。
//
// 本文件锁两件事：① 只有 sqlite.mjs 一个加载点；② 缺的时候报错要能指导行动。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RT = path.join(HERE, "..", "lib", "redteam");

test("redteam: node:sqlite 只在 sqlite.mjs 里加载", () => {
  const files = fs.readdirSync(RT).filter((f) => /\.(js|mjs)$/.test(f));
  const offenders = [];
  for (const f of files) {
    if (f === "sqlite.mjs") continue;
    const text = fs.readFileSync(path.join(RT, f), "utf8");
    // 只查模块引用形态，注释里提到不算
    if (/(?:from\s+|import\()\s*["']node:sqlite["']/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], "这些文件应改为 import { DatabaseSync } from './sqlite.mjs'");
});

test("redteam: sqlite.mjs 用动态 import 以便给出可读报错", () => {
  const text = fs.readFileSync(path.join(RT, "sqlite.mjs"), "utf8");
  assert.match(text, /await import\(\s*["']node:sqlite["']\s*\)/, "必须是动态 import");
  assert.match(text, /DSH_PURGE_SQLITE_UNAVAILABLE/, "应带可识别的错误码");
  assert.match(text, /22\.5/, "错误信息应点明需要的版本");
  assert.match(text, /process\.versions\.node/, "错误信息应带当前运行时版本");
});

test("redteam: 依赖 sqlite 的模块都能加载（宿主运行时下）", async () => {
  // 本机会由测试进程的 node 决定；node >= 22.5 时应全部成功
  const majors = Number(String(process.versions.node).split(".")[0]);
  for (const f of ["schema.js", "store-core.js", "evidence-ledger.mjs"]) {
    try {
      const m = await import("file:///" + path.join(RT, f).replace(/\\/g, "/"));
      assert.ok(Object.keys(m).length > 0 || f === "evidence-ledger.mjs", `${f} 应该有导出`);
    } catch (e) {
      if (majors >= 22) throw e;
      // 老运行时只要求错误可读，不要求能加载
      assert.match(String(e.message), /node:sqlite|22\.5/, `${f} 的失败信息应可行动`);
    }
  }
});

test("redteam: sqlite.mjs 导出的 DatabaseSync 能用", { skip: Number(String(process.versions.node).split(".")[0]) < 22 }, async () => {
  const m = await import("file:///" + path.join(RT, "sqlite.mjs").replace(/\\/g, "/"));
  assert.equal(typeof m.DatabaseSync, "function");
  const db = new m.DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (42);");
    const row = db.prepare("SELECT a FROM t").get();
    assert.equal(row.a, 42);
  } finally {
    try { db.close(); } catch {}
  }
});
