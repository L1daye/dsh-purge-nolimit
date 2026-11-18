// 88 条补丁的锚点健康度检查。
//
// 这个测试防的事故：DSH 升级后某条补丁的锚点漂移，apply() 静默变成
// missing_file / failed，而面板只少一个数——没人会发现。
//
// 状态分类：
//   ANCHOR   文件里有 pattern          → 下次 apply 会改
//   APPLIED  文件里有 replace 或 marker → 已经改过
//   NA       目标文件不存在             → 本机没装那个包
//   EMPTY    replacement.pattern 是空对象 → 无效段（历史残留），单独告警不算失败
//   DRIFT    三种都不是                 → 真漂移，失败
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ALL_PATCHES,
  targetFiles,
  findAiBase,
  applyReplacementsToText,
} from "../lib/core.js";

function resolveAiBase() {
  const fromEnv = process.env.PURGE_AI_BASE;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const found = findAiBase();
    if (found && fs.existsSync(found)) return found;
  } catch { /* ignore */ }
  return "";
}

const AI_BASE = resolveAiBase();
const HAS_HOST = AI_BASE !== "";

function files() {
  if (!HAS_HOST) return {};
  try { return targetFiles(AI_BASE); } catch { return {}; }
}

function isEmptyPattern(p) {
  // RegExp 的 Object.keys 也是空数组，必须显式排除——它是有效的 pattern 类型。
  if (p instanceof RegExp) return false;
  return p !== null && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 0;
}

// 布局软补丁：官方副本布局不同、或判据句已被上游改写时，没有残留 pattern 就算完成。
// 判定逻辑抄自 core.js 的 isLayoutSoftPatch（那是内部函数，不导出）。
//   身份类 #4/#25/#26 · 审批句类 #5/#11/#12 · 或带 softSettle
const SOFT_PATCH_IDS = new Set([4, 5, 11, 12, 25, 26]);
function isLayoutSoftPatch(p) {
  return Boolean(p && (SOFT_PATCH_IDS.has(p.id) || p.softSettle));
}

function nodeCheck(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-syntax-"));
  const file = path.join(dir, "probe.mjs");
  try {
    fs.writeFileSync(file, source);
    return spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 收集每条补丁的「无效段」，供多个测试复用
function emptyPatterns() {
  const out = [];
  for (const p of ALL_PATCHES) {
    for (const [i, r] of (p.replacements || []).entries()) {
      if (!r) { out.push({ id: p.id, name: p.name, i, kind: "null" }); continue; }
      if (isEmptyPattern(r.pattern)) out.push({ id: p.id, name: p.name, i, kind: "empty" });
    }
  }
  return out;
}

test("宿主可定位（否则下面的检查全部跳过）", () => {
  if (!HAS_HOST) {
    console.log("    ⚠ 未找到宿主 aiBase，设置 PURGE_AI_BASE 后重跑");
    return;
  }
  assert.ok(fs.existsSync(AI_BASE), "aiBase 必须存在: " + AI_BASE);
  console.log("    aiBase = " + AI_BASE);
});

test("锚点：每条补丁在自己的真实文件里都能对上（或已应用）", () => {
  if (!HAS_HOST) return;
  const f = files();
  const drift = [];
  const stats = { ANCHOR: 0, APPLIED: 0, NA: 0, EMPTY: 0, NOFILE: 0 };

  for (const p of ALL_PATCHES) {
    const keys = Array.isArray(p.file) ? p.file : p.file ? [p.file] : [];
    if (keys.length === 0) { stats.NOFILE++; continue; }

    for (const key of keys) {
      const fp = f[key];
      if (!fp || !fs.existsSync(fp)) { stats.NA++; continue; }
      let src;
      try { src = fs.readFileSync(fp, "utf8"); } catch { stats.NA++; continue; }

      for (const [ri, r] of (p.replacements || []).entries()) {
        if (!r || isEmptyPattern(r.pattern)) { stats.EMPTY++; continue; }
        const isRe = r.pattern instanceof RegExp;
        if (typeof r.pattern !== "string" && !isRe) {
          drift.push(`#${p.id} ${p.name} r[${ri}] @ ${key}: pattern 类型是 ${typeof r.pattern}`);
          continue;
        }
        // 正则 pattern：用 cloneRegExp 重置 lastIndex 再 test
        const hasAnchor = isRe
          ? new RegExp(r.pattern.source, r.pattern.flags.replace("g", "")).test(src)
          : src.includes(r.pattern);
        const hasReplace =
          typeof r.replace === "string" && r.replace.length > 0 && src.includes(r.replace);
        const hasMarker = (p.markers || []).some((m) => typeof m === "string" && m && src.includes(m));

        if (hasAnchor) stats.ANCHOR++;
        else if (hasReplace || hasMarker) stats.APPLIED++;
        else if (isLayoutSoftPatch(p) || p.optional) stats.SOFT = (stats.SOFT || 0) + 1;
        else {
          drift.push(
            `#${String(p.id).padStart(3)} ${p.name} r[${ri}] @ ${key}\n` +
            // pattern 可能是 RegExp（#40/#92 就是），直接 .slice 会 TypeError，
            // 把真正的漂移信息吞掉——这条报错分支自己崩过。
            `        pattern: ${JSON.stringify(
              typeof r.pattern === "string" ? r.pattern.slice(0, 110) : String(r.pattern).slice(0, 110)
            )}`
          );
        }
      }
    }
  }

  console.log(
    `    锚点 ${stats.ANCHOR} · 已应用 ${stats.APPLIED} · 软/可选合流 ${stats.SOFT || 0} · 不适用 ${stats.NA} · 空段 ${stats.EMPTY}`
  );
  if (drift.length) {
    console.log("    ▼ 锚点漂移：");
    for (const d of drift) console.log("      " + d);
  }
  assert.deepEqual(drift, [], `有 ${drift.length} 处锚点漂移`);
});

// 空 pattern 段是历史残留：String.replace({}, ...) 不匹配任何东西，是无害的空操作。
// #3/#21/#73/#67/#53 这些上游也有（设计如此，靠 markers / softSettle / forbid 生效）；
// #17/#40/#62 是我们独有的冗余段，有有效段兜底，同样不影响功能。
// 所以这里只告警，不判失败——真要清理单独立项。
test("空 pattern 段只告警（无害空操作）", () => {
  const empties = emptyPatterns();
  const byId = new Map();
  for (const e of empties) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e.i);
  }
  if (byId.size) {
    console.log("    ⚠ 空 pattern 段（无害，可择期清理）：");
    for (const [id, idxs] of byId) {
      const p = ALL_PATCHES.find((x) => x.id === id);
      const total = (p?.replacements || []).length;
      const valid = total - idxs.length;
      console.log(
        `      #${String(id).padStart(3)} ${p?.name} r[${idxs.join(",")}] of ${total}` +
        (valid === 0 ? "  ← 该补丁无有效段（依赖 markers/softSettle）" : `  另有 ${valid} 段有效`)
      );
    }
  } else {
    console.log("    没有空 pattern 段");
  }
  assert.ok(true, "空段不阻塞");
});

test("每条补丁应用到自己的真实文件后，语法仍然正确", () => {
  if (!HAS_HOST) return;
  const f = files();
  const broken = [];
  let checked = 0;

  for (const p of ALL_PATCHES) {
    const keys = Array.isArray(p.file) ? p.file : p.file ? [p.file] : [];
    for (const key of keys) {
      const fp = f[key];
      if (!fp || !fs.existsSync(fp)) continue;
      if (!/\.(js|mjs|cjs)$/.test(fp)) continue;
      let src;
      try { src = fs.readFileSync(fp, "utf8"); } catch { continue; }
      const already = (p.markers || []).some((m) => m && src.includes(m));
      if (already) continue;

      let out;
      try { out = applyReplacementsToText(src, p, fp); } catch (e) {
        broken.push(`#${p.id} ${p.name}: apply 抛错 ${e.message}`);
        continue;
      }
      if (!out || !out.changed) continue;
      checked++;
      const r = nodeCheck(out.text);
      if (r.status !== 0) {
        const msg = (r.stderr || "").split("\n").find((l) => /Error/.test(l)) || "";
        broken.push(`#${p.id} ${p.name}: 改写后语法错误 ${msg.slice(0, 120)}`);
      }
    }
  }

  console.log(`    实际改写验证 ${checked} 处`);
  if (broken.length) for (const b of broken) console.log("      " + b);
  assert.deepEqual(broken, [], `有 ${broken.length} 处改写后语法损坏`);
});

test("apply 两次等于一次（幂等）", () => {
  if (!HAS_HOST) return;
  const f = files();
  const bad = [];
  let checked = 0;

  for (const p of ALL_PATCHES) {
    const keys = Array.isArray(p.file) ? p.file : p.file ? [p.file] : [];
    for (const key of keys) {
      const fp = f[key];
      if (!fp || !fs.existsSync(fp)) continue;
      if (!/\.(js|mjs|cjs)$/.test(fp)) continue;
      let src;
      try { src = fs.readFileSync(fp, "utf8"); } catch { continue; }
      const already = (p.markers || []).some((m) => m && src.includes(m));
      if (already) continue;

      let once, twice;
      try {
        once = applyReplacementsToText(src, p, fp);
        if (!once || !once.changed) continue;
        twice = applyReplacementsToText(once.text, p, fp);
      } catch (e) {
        bad.push(`#${p.id} ${p.name}: 抛错 ${e.message}`);
        continue;
      }
      checked++;
      if (twice.changed) bad.push(`#${p.id} ${p.name}: 第二次仍然 changed`);
      else if (twice.text !== once.text) bad.push(`#${p.id} ${p.name}: 第二次文本变了`);
    }
  }

  console.log(`    幂等验证 ${checked} 处`);
  if (bad.length) for (const x of bad) console.log("      " + x);
  assert.deepEqual(bad, [], `有 ${bad.length} 处不幂等`);
});

test("补丁表结构一致性", () => {
  const ids = new Set();
  const dup = [];
  for (const p of ALL_PATCHES) {
    if (ids.has(p.id)) dup.push(p.id);
    ids.add(p.id);
  }
  assert.deepEqual(dup, [], "补丁 id 必须唯一");

  const noName = ALL_PATCHES.filter((p) => !p.name).map((p) => p.id);
  assert.deepEqual(noName, [], "每条补丁必须有 name");

  // file 可以是字符串或数组；有 rel 的（profile 层补丁）也算有目标
  const noFile = ALL_PATCHES.filter((p) => {
    const hasFile = (typeof p.file === "string" && p.file) ||
                    (Array.isArray(p.file) && p.file.length > 0);
    const hasRel = Array.isArray(p.rel) && p.rel.length > 0;
    return !hasFile && !hasRel;
  }).map((p) => p.id);
  assert.deepEqual(noFile, [], "每条补丁必须有 file 或 rel");

  console.log(`    ${ALL_PATCHES.length} 条补丁，结构检查通过`);
});
