// 探针段的注册顺序。
//
// 真实事故（2.3.29）：`registerProbeSection` 被放在 `if (!postPrompt) return;` 之后，
// 而默认配置的 postPrompt 是空串 —— 于是整个探针功能静默失效。
// 文件写对了、API 返回 active=true、单元测试全绿，只有真发一句话才看得出来。
//
// 这个测试直接读源码断言调用顺序，防止再犯。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(here, "..", "lib", "index.js"), "utf8");

test("registerProbeSection is called before the postPrompt early-return", () => {
  const body = SRC.slice(SRC.indexOf("export function registerPromptSections"));
  assert.ok(body.length > 0, "registerPromptSections must exist");

  const probeAt = body.indexOf("registerProbeSection(ctx, config)");
  assert.ok(probeAt >= 0, "probe section must be registered somewhere in registerPromptSections");

  const retAt = body.indexOf("if (!postPrompt) return;");
  assert.ok(retAt >= 0, "the postPrompt early-return guard must still exist");

  assert.ok(
    probeAt < retAt,
    "registerProbeSection must run BEFORE `if (!postPrompt) return;` " +
      "— otherwise installs without postPrompt never get a probe section (2.3.29 regression)",
  );
});

test("the probe section reads probeText at assembly time, not once at startup", () => {
  // 必须是 text: () => ... 形式的惰性求值：探针可能在 apply 之后才被创建，
  // 若在注册时就把文本算好，之后创建的探针永远不会进提示词。
  const idx = SRC.indexOf("function registerProbeSection");
  assert.ok(idx >= 0);
  const body = SRC.slice(idx, idx + 900);
  assert.match(body, /text:\s*\(\)\s*=>/, "probe section text must be a thunk");
  assert.match(body, /probeText\(/, "thunk must call probeText");
});

test("the probe section honours injectAllowedNow", () => {
  // excludePresets 等开关必须同样作用于探针，否则会出现「排除了预设但探针还在」。
  const idx = SRC.indexOf("function registerProbeSection");
  const body = SRC.slice(idx, idx + 900);
  assert.match(body, /injectAllowedNow\(config\)/, "probe section must respect injectAllowedNow");
});

test("probe section uses a stable name and a finite order", () => {
  const idx = SRC.indexOf("function registerProbeSection");
  const body = SRC.slice(idx, idx + 900);
  assert.match(body, /name:\s*probe\.PROBE_SECTION/, "must use the exported section name");
  assert.match(body, /order:\s*config\.probeOrder\s*\?\?\s*probe\.PROBE_ORDER/, "must allow override, default to PROBE_ORDER");
});

test("postPrompt still degrades to skip instead of throwing", () => {
  // 旧版 throw 会把整个 apply 炸掉。这条防回退。
  assert.match(SRC, /跳过 postPrompt 段/);
  assert.ok(!/throw new Error\([^)]*postPromptOrder/.test(SRC), "must not throw on bad postPromptOrder");
});
