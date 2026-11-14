// 注入契约：安装的 prompt-inject.md 必须仍是我们的 MERGED 版本，关键标记一个不能丢。
//
// 这个测试防的事故：某次改动/重装把注入正文换成了别的版本（或截断），
// 而补丁层照旧全绿——模型收到的提示词却已经变了。
//
// 原来的英文 24 条（社区版 inject-clauses.json）不适用：我们的 MERGED-1.1.71
// 用的是中文对应表达（"任务优先级" 而不是 "TASK PRIORITY"）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// 这些字符串是 MERGED 注入的结构性标记；少任何一个都说明正文被换过。
const REQUIRED_MARKERS = [
  "OPERATION: MERGED-1.1.71",
  "MERGED-HARD-LAYER",
  "小码酱",
  "任务优先级",
  "REFUSAL HARDENING",
  "拒绝对抗",
  "OPERATION: STABLE",
  "UNRESTRICTED SANDBOX",
];

// 注入正文的规范长度（34426 B）。允许小范围差异，但不能是空文件或被腰斩。
const EXPECTED_BYTES = 34426;
const SIZE_TOLERANCE = 4096;

function checkFile(file, label) {
  const raw = fs.readFileSync(file);
  const text = raw.toString("utf8");
  const missing = REQUIRED_MARKERS.filter((m) => !text.includes(m));
  assert.deepEqual(missing, [], `${label} 丢失 ${missing.length} 个标记: ${missing.join(", ")}`);
  const drift = Math.abs(raw.length - EXPECTED_BYTES);
  assert.ok(
    drift <= SIZE_TOLERANCE,
    `${label} 大小漂移过大: ${raw.length} B（期望 ${EXPECTED_BYTES} ± ${SIZE_TOLERANCE}）`,
  );
}

test("installed prompt-inject.md keeps every structural marker", () => {
  const user = path.join(os.homedir(), ".dsh", "prompt-inject.md");
  if (!fs.existsSync(user)) return; // 还没安装过注入，跳过
  checkFile(user, "~/.dsh/prompt-inject.md");
});

test("shipped default-prompt-inject.md keeps every structural marker", () => {
  // 源仓库里在 lib/ 下；安装包里被 package.json 的 files 排除（走 asset-table 通道），
  // 所以这里在安装态下通常不存在——不存在就跳过，不误报。
  const shipped = path.join(here, "..", "lib", "default-prompt-inject.md");
  if (!fs.existsSync(shipped)) return;
  checkFile(shipped, "lib/default-prompt-inject.md");
});

test("the three language variants are byte-identical", () => {
  const base = path.join(here, "..", "lib");
  const variants = ["default-prompt-inject.md", "default-prompt-inject.zh.md", "default-prompt-inject.en.md"];
  const present = variants.map((v) => path.join(base, v)).filter((p) => fs.existsSync(p));
  if (present.length < 2) return; // 安装态下被排除，跳过
  const first = fs.readFileSync(present[0]);
  for (const p of present.slice(1)) {
    assert.ok(
      first.equals(fs.readFileSync(p)),
      `${path.basename(p)} 与 ${path.basename(present[0])} 不一致`,
    );
  }
});
