// lib/ 里的脚本入口必须能安全地被 import。
//
// 事故：2.3.37 的远程探针枚举 `lib/*.js` 逐个 import，撞上 `reapply-cli.js`——
// 那个文件是 177 字节的纯顶层代码，import 等于「revert 55 个宿主文件 + 重新打
// 72 个补丁 + process.exit」。探针在第一段就被打断，宿主被无预期地全量回滚重建。
//
// 这类文件本质是脚本，但躺在 lib/ 里、名字也不带 .cli 后缀，任何 introspection
// 工具都会踩到。修法是给它们加 main-guard / 改成抛错，本文件锁住这个性质。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib");

/** 已知的脚本入口：被 import 时必须不产生副作用。 */
const ENTRY_SCRIPTS = ["reapply-cli.js", "restart-web.js", "restart-desktop.js", "uninstall-restart.js"];

/** 在临时环境里 import 一个模块，捕获 process.exit 与异常。 */
async function importGuarded(file) {
  const realExit = process.exit;
  let exitCalled = null;
  process.exit = (code) => {
    exitCalled = code ?? 0;
    throw new Error(`process.exit(${exitCalled}) during import`);
  };
  try {
    const mod = await import(pathToFileURL(path.join(LIB, file)).href);
    return { ok: true, exports: Object.keys(mod).length, exitCalled, error: null };
  } catch (e) {
    return { ok: false, exports: 0, exitCalled, error: e };
  } finally {
    process.exit = realExit;
  }
}

test("entry scripts: lib 里的脚本入口清单与磁盘一致", () => {
  for (const f of ENTRY_SCRIPTS) assert.ok(fs.existsSync(path.join(LIB, f)), `${f} 不存在`);
});

test("entry scripts: import 时绝不调用 process.exit", async () => {
  for (const f of ENTRY_SCRIPTS) {
    const r = await importGuarded(f);
    assert.equal(r.exitCalled, null, `${f} 在 import 时调用了 process.exit(${r.exitCalled})`);
  }
});

test("entry scripts: reapply-cli.js 被 import 时是完全的空操作", async () => {
  const r = await importGuarded("reapply-cli.js");
  assert.equal(r.ok, true, `不应抛错：${r.error && r.error.message}`);
  assert.equal(r.exports, 0, "脚本入口不该导出任何东西");
});

test("entry scripts: 缺环境变量时抛可捕获的错误而不是静默 exit", async () => {
  const saved = process.env.DSH_PURGE_RESTART;
  delete process.env.DSH_PURGE_RESTART;
  try {
    for (const f of ["restart-web.js", "restart-desktop.js", "uninstall-restart.js"]) {
      const r = await importGuarded(f);
      assert.equal(r.ok, false, `${f} 缺 env 时应抛错`);
      assert.match(String(r.error.message), /脚本入口|DSH_PURGE_RESTART/, `${f} 的错误信息应说明原因`);
      assert.equal(r.exitCalled, null, `${f} 不该 process.exit`);
    }
  } finally {
    if (saved !== undefined) process.env.DSH_PURGE_RESTART = saved;
  }
});

test("entry scripts: 这些文件只被当作子进程路径引用，没有 import 语句指向它们", () => {
  const files = fs.readdirSync(LIB).filter((f) => /\.(js|mjs)$/.test(f));
  const importers = [];
  for (const f of files) {
    if (ENTRY_SCRIPTS.includes(f)) continue;
    const text = fs.readFileSync(path.join(LIB, f), "utf8");
    for (const entry of ENTRY_SCRIPTS) {
      const stem = entry.replace(/\.js$/, "");
      // 只查 `from "./xxx"` / `import("...xxx")` 这种模块引用
      const re = new RegExp(`(?:from\\s+|import\\()\\s*["'][^"']*${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.js["']`);
      if (re.test(text)) importers.push(`${f} -> ${entry}`);
    }
  }
  assert.deepEqual(importers, [], "这些文件只能作为子进程脚本路径被 spawn，不能被 import");
});
