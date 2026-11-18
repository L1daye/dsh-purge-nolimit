// 宿主自动发现绝不能返回临时目录。
//
// 事故：兜底递归扫描的根里有 os.homedir()，Windows 上 %TEMP% 就在
// %USERPROFILE%\AppData\Local\Temp 下面，深度上限 6 恰好够走到
//   Temp\<fixture>\patch-host\node_modules\@deepseek-ai
// 而测试留下的 fixture 与真实安装结构完全相同（isAiBase 只查
// dsh-agent-instructions/lib 是不是目录）。于是 findAiBase() 把测试夹具
// 当成宿主返回。
//
// 实测后果：在仓库目录跑 node --test，patch-anchors 拿到的是临时夹具——
// 132 条补丁判成「不适用」、7 条「已应用」，对着一个假宿主下结论；
// 更危险的是 `--apply` 从任意工作目录调用时可能去改夹具并报告成功。
//
// 本测试锁两件事：① 自动发现不返回临时目录；② 显式 DSH_BASE 仍可指向任何位置。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const core = await import("../lib/core.js");

function underTemp(p) {
  if (!p) return false;
  const a = path.resolve(String(p)).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  const t = path.resolve(os.tmpdir()).replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  return a === t || a.startsWith(t + "/");
}

/** 造一个和真实安装结构一致、但位于临时目录的假宿主。 */
function makeTempHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-guard-"));
  const ai = path.join(root, "patch-host", "node_modules", "@deepseek-ai");
  fs.mkdirSync(path.join(ai, "dsh-agent-instructions", "lib"), { recursive: true });
  fs.writeFileSync(path.join(ai, "dsh-agent-instructions", "package.json"), '{"name":"x","version":"0.0.0"}', "utf8");
  return { root, ai };
}

test("假宿主确实长得像真宿主（否则本测试无效）", () => {
  const { root, ai } = makeTempHost();
  try {
    // isAiBase 的判据就是 dsh-agent-instructions/lib 是目录
    assert.ok(fs.statSync(path.join(ai, "dsh-agent-instructions", "lib")).isDirectory());
    assert.ok(underTemp(ai), "夹具必须位于临时目录，否则测不到这个分支");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("findAiBase 不返回临时目录里的夹具", () => {
  const { root, ai } = makeTempHost();
  try {
    const found = core.findAiBase();
    assert.equal(underTemp(found), false, `findAiBase 返回了临时路径：${found}`);
    assert.notEqual(path.normalize(found || ""), path.normalize(ai));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("enumeratePatchAiBases 不收集临时目录里的夹具", () => {
  const { root, ai } = makeTempHost();
  try {
    const list = core.enumeratePatchAiBases();
    const bad = list.filter((p) => underTemp(p));
    assert.deepEqual(bad, [], "枚举到了临时目录：" + bad.join(", "));
    assert.equal(list.some((p) => path.normalize(p) === path.normalize(ai)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("targetFiles 对临时夹具仍然可用（显式传入不受影响）", () => {
  const { root, ai } = makeTempHost();
  try {
    // 显式给出路径时不该被"临时目录"判定挡住——夹具测试依赖这条路
    const f = core.targetFiles(ai);
    assert.equal(typeof f, "object");
    assert.ok(Object.keys(f).length > 0, "targetFiles 应该对任何路径都返回键表");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
