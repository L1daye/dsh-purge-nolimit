#!/usr/bin/env node
/**
 * dsh-purge 部署自检 / post-deploy self-check.
 *
 * 一次跑完「部署完之后到底有没有真的生效」这件事，专门覆盖那些
 * 补丁状态看着正常、但实际空转的情况。
 *
 * 用法：
 *   node scripts/selfcheck.mjs                # 人读
 *   node scripts/selfcheck.mjs --json         # 机器读
 *   node scripts/selfcheck.mjs --http         # 额外查询运行中的宿主（/dsh-purge/status、/dsh-purge/audit）
 *   node scripts/selfcheck.mjs --http-port 52386
 *
 * 退出码：0 全过 / 1 有 FAIL / 2 有 WARN（无 FAIL）
 *
 * 只读：不写宿主文件、不改配置。补丁幂等检查走内存比对，不落盘。
 */

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, "..", "lib");

const argv = process.argv.slice(2);
const wantJson = argv.includes("--json");
const wantHttp = argv.includes("--http");
const portIdx = argv.indexOf("--http-port");
const forcedPort = portIdx >= 0 ? argv[portIdx + 1] : "";

const results = [];
function rec(level, id, detail, hint) {
  results.push({ level, id, detail: String(detail ?? ""), hint: hint ? String(hint) : "" });
}

async function load(file) {
  return import(new URL(`file://${path.join(LIB, file).replace(/\\/g, "/")}`).href);
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function pkgVersion(dir) {
  const j = readJson(path.join(dir, "package.json"));
  return j && typeof j.version === "string" ? j.version : "";
}

/** 从 aiBase 反推安装根：<install>/resources/app/dsh/node_modules/@deepseek-ai */
function deriveLayout(aiBase) {
  if (!aiBase) return { install: "", resources: "", appDir: "", dshDir: "" };
  const dshDir = path.dirname(path.dirname(aiBase)); // .../app/dsh
  const appDir = path.dirname(dshDir); // .../app
  const resources = path.dirname(appDir); // .../resources
  const install = path.dirname(resources); // <install>
  return { install, resources, appDir, dshDir };
}

async function main() {
  const core = await load("core.js");
  const extract = await load("extract-asar.js");

  const dshHome = core.findDshHome();
  const aiBase = core.findAiBase() || "";
  const layout = deriveLayout(aiBase);

  // ── 1. 插件自身 ─────────────────────────────────────────────
  const pluginDir = path.join(dshHome, "profiles");
  let pluginVersion = "";
  try {
    for (const name of readdirSync(pluginDir)) {
      const pj = path.join(pluginDir, name, "node_modules", "dsh-purge", "package.json");
      if (existsSync(pj)) {
        const v = pkgVersion(path.join(pluginDir, name, "node_modules", "dsh-purge"));
        if (!pluginVersion) pluginVersion = `${v} (${name})`;
      }
    }
  } catch { /* ignore */ }
  rec(pluginVersion ? "PASS" : "FAIL", "plugin.present", pluginVersion || "dsh-purge not found under profiles/*/node_modules");

  const selfPkg = readJson(path.join(HERE, "..", "package.json"));
  rec("INFO", "plugin.self", `${selfPkg?.version ?? "?"} dshTarget=${selfPkg?.dshTarget ?? "?"}` + (Array.isArray(selfPkg?.dshTargets) && selfPkg.dshTargets.length > 1 ? ` (also: ${selfPkg.dshTargets.filter((v) => v !== selfPkg.dshTarget).join("/")})` : ""));

  // ── 2. 宿主定位 ─────────────────────────────────────────────
  rec(aiBase ? "PASS" : "FAIL", "host.aiBase", aiBase || "findAiBase() 返回空",
    aiBase ? "" : "宿主没装、没解包，或安装路径不在探测范围内");

  const appPkg = layout.appDir ? readJson(path.join(layout.appDir, "package.json")) : null;
  rec(appPkg ? "PASS" : "FAIL", "host.appPackage",
    appPkg ? `${appPkg.name}@${appPkg.version}` : "resources/app/package.json 读不到（装的是密封 asar，还没解包）");

  // ── 3. 加载路径：asar 有没有把 app/ 遮住 ────────────────────
  const asarPath = layout.resources ? path.join(layout.resources, "app.asar") : "";
  const asarPresent = asarPath ? existsSync(asarPath) : false;
  const appDirPresent = layout.appDir ? existsSync(layout.appDir) : false;

  if (asarPresent && appDirPresent) {
    rec("FAIL", "loader.asar_shadow",
      "resources/app.asar 与 resources/app 同时存在 —— Electron 加载归档，app/ 里的补丁不会被 require",
      `改名挪开：Rename-Item "${asarPath}" "app.asar.dshpurge.bak"`);
  } else if (asarPresent && !appDirPresent) {
    rec("FAIL", "loader.asar_only", "只有 app.asar，宿主是密封包，补丁无处可落",
      "先解包（extractAsarToSide + renameAsarAside + commitExtractedDir），或让插件走 handoff 流程");
  } else if (!asarPresent && appDirPresent) {
    rec("PASS", "loader.asar_shadow", "app.asar 已挪开，加载的是 resources/app");
  } else {
    rec("FAIL", "loader.asar_shadow", "既没有 app.asar 也没有 resources/app");
  }

  // 目标版本与 app/ 版本是否一致（防止解的是旧归档）。
  //
  // 一个包同时服务多个宿主版本：`dshTargets` 里任何一个都算达标，
  // `dshTarget` 只是"主目标"（用于展示）。只看单值会把另一台机器误判成漂移。
  const targets = Array.isArray(selfPkg?.dshTargets) && selfPkg.dshTargets.length
    ? selfPkg.dshTargets.map(String)
    : [String(selfPkg?.dshTarget || "")].filter(Boolean);
  if (appPkg && targets.length) {
    const same = targets.includes(appPkg.version);
    rec(same ? "PASS" : "WARN", "loader.versionMatch",
      `app=${appPkg.version} targets=${targets.join("/")}`,
      same ? "" : "解包出来的版本不在已验证列表里，锚点可能对不上");
  }

  // ── 4. CLI 启动器 ──────────────────────────────────────────
  for (const [id, fn] of [["cli.findShimDir", "findShimDir"], ["cli.findDesktopShimDir", "findDesktopShimDir"]]) {
    let v = null;
    try { v = typeof core[fn] === "function" ? core[fn]() : null; } catch { v = null; }
    rec(v ? "PASS" : "WARN", id, v || "null",
      v ? "" : "rc.3 起 resources/runtime/cli/bin 是空的，需要手动补 dsh.cmd / dsh.ps1 / dsh（见 AGENTS.md 陷阱 22）");
  }
  if (layout.resources) {
    const cliBin = path.join(layout.resources, "runtime", "cli", "bin");
    // Windows 上 dsh.cmd 是必需的；dsh / dsh.ps1 只服务 WSL/Git Bash 与 PowerShell，
    // 缺了降级为 INFO，避免在只有 .cmd 的机器上刷噪声。
    const required = process.platform === "win32" ? ["dsh.cmd"] : ["dsh"];
    for (const f of ["dsh", "dsh.cmd", "dsh.ps1"]) {
      const p = path.join(cliBin, f);
      const present = existsSync(p);
      const level = present ? "PASS" : required.includes(f) ? "WARN" : "INFO";
      rec(level, `cli.${f}`, present ? "present" : "missing", present ? "" : "见 AGENTS.md 陷阱 22");
    }
  }

  // ── 5. 补丁状态 ─────────────────────────────────────────────
  let st = {};
  if (aiBase) {
    try { st = await core.patchStatus(aiBase, core.ALL_PATCHES); } catch (e) { rec("FAIL", "patch.status", `patchStatus 抛错：${e.message}`); }
  }
  const tally = {};
  for (const v of Object.values(st)) tally[v] = (tally[v] || 0) + 1;
  rec(st && Object.keys(st).length ? "PASS" : "FAIL", "patch.tally", JSON.stringify(tally));

  const byId = new Map(core.ALL_PATCHES.map((p) => [String(p.id), p]));
  const bad = [];
  const skippedSoft = [];
  for (const [id, v] of Object.entries(st)) {
    if (v === "applied" || v === "na") continue;
    const p = byId.get(id);
    const line = `#${id} ${p ? p.name : "?"} = ${v}`;
    if (v === "skipped" && p && (p.optional === true || p.softSettle || [56, 76, 80].includes(Number(id)))) {
      skippedSoft.push(line);
    } else {
      bad.push(line);
    }
  }
  rec(bad.length ? "FAIL" : "PASS", "patch.nonApplied",
    bad.length ? bad.join(" | ") : "除设计内的软补丁外全部 applied",
    bad.length ? "这些不是 na 也不是软跳过，是真漂移：补锚点或查 targetFiles key" : "");
  if (skippedSoft.length) rec("INFO", "patch.softSkipped", skippedSoft.join(" | "));

  // ── 5b. 语义分层 ─────────────────────────────────────────────
  try {
    const L = await load("layers.js");
    const coverage = L.checkLayerCoverage(core.ALL_PATCHES);
    rec(coverage.ok ? "PASS" : "FAIL", "layer.coverage",
      coverage.ok ? `${L.BYPASS_LAYERS.length} 层覆盖全部 ${core.ALL_PATCHES.length} 条` : `未分层: ${JSON.stringify(coverage.missing)} 幽灵: ${JSON.stringify(coverage.ghost)}`,
      coverage.ok ? "" : "每条补丁必须落进某一层，否则会在面板上凭空消失");
    if (st && Object.keys(st).length) {
      const rolled = L.rollupLayers(st, core.ALL_PATCHES);
      const tally = {};
      for (const l of rolled) tally[l.state] = (tally[l.state] || 0) + 1;
      const notOk = rolled.filter((l) => l.state !== "ok" && l.state !== "na");
      rec(notOk.length ? "FAIL" : "PASS", "layer.state",
        JSON.stringify(tally) + (notOk.length ? " -> " + notOk.map((l) => `${l.title}:${l.state}`).join(", ") : ""),
        notOk.length ? "按层看哪个用户痛点没拆掉；pending 点一次应用，broken 要查锚点" : "");
    }
  } catch (e) { rec("WARN", "layer.state", `跳过：${e.message}`); }

  // ── 5c. 重锚覆盖 ─────────────────────────────────────────────
  try {
    const A = await load("anchors.js");
    const ov = A.readOverrides(dshHome);
    const ids = Object.keys(ov || {});
    rec("INFO", "anchors.overrides", ids.length ? `${ids.length} 条本地重锚：${ids.map((i) => "#" + i).join(",")}` : "无本地重锚（用出厂锚点）");
  } catch (e) { rec("INFO", "anchors.overrides", `读不到：${e.message}`); }

  // ── 6. 幂等（内存比对，不落盘）──────────────────────────────
  if (aiBase) {
    try {
      const files = core.targetFiles(aiBase);
      let wouldChange = [];
      for (const p of core.ALL_PATCHES) {
        const keys = Array.isArray(p.file) ? p.file : p.file ? [p.file] : [];
        let touched = false;
        for (const k of keys) {
          const v = files[k];
          const arr = Array.isArray(v) ? v : v ? [v] : [];
          for (const fp of arr) {
            let text;
            try { text = readFileSync(fp, "utf8"); } catch { continue; }
            try {
              if (core.applyReplacementsToText(text, p, fp).changed) touched = true;
            } catch { /* 单条抛错不影响整体判定 */ }
            if (touched) break;
          }
          if (touched) break;
        }
        if (touched) wouldChange.push(`#${p.id}`);
      }
      rec(wouldChange.length ? "FAIL" : "PASS", "patch.idempotent",
        wouldChange.length ? `再 apply 还会改：${wouldChange.join(",")}` : "再 apply 不会改动任何文件（已收敛）");
    } catch (e) { rec("WARN", "patch.idempotent", `跳过：${e.message}`); }
  }

  // ── 7. 提示词槽 ────────────────────────────────────────────
  try {
    const tableRead = await load("table-read.js");
    const slot = tableRead.openSlot();
    const need = ["Little Code Sauce", "CTF Core Contract", "CTF Scope and Evidence", "Sandbox test directions"];
    const missing = need.filter((n) => !slot.includes(n));
    rec(slot && !missing.length ? "PASS" : "WARN", "prompt.slot",
      `chars=${slot.length} missing=${JSON.stringify(missing)}`,
      missing.length ? "槽缺段落，可能是旧槽没重新 seal（npm run embed-prompt）" : "");
    rec("INFO", "prompt.sealedTable", `asarShadowsPath(aiBase)=${safe(() => extract.asarShadowsPath(aiBase))}`);
  } catch (e) { rec("FAIL", "prompt.slot", `openSlot 抛错：${e.message}`); }

  // ── 8. 运行中的宿主（可选）──────────────────────────────────
  if (wantHttp) {
    const base = `http://127.0.0.1:${forcedPort || 11336}`;
    let liveStatus = null;
    for (const [id, route] of [["live.status", "/dsh-purge/status"], ["live.audit", "/dsh-purge/audit"]]) {
      try {
        const r = await fetch(base + route);
        const j = await r.json();
        if (route.endsWith("status")) {
          liveStatus = j;
          rec(j.ok ? "PASS" : "FAIL", id,
            `surface=${j.surface} patches=${j.patches_applied}/${j.patches_total} pending=${j.patches_pending} na=${j.patches_na} lost=${j.patches_lost} assemble_failures=${JSON.stringify(j.assemble_failures ?? null)}`);
        } else {
          rec(j.full_break ? "PASS" : "FAIL", id, `passed=${j.passed}/${j.total} full_break=${j.full_break} version=${j.version}`);
        }
      } catch (e) { rec("WARN", id, `连不上 ${base}${route}：${e.message}`, "宿主没跑或端口不同，用 --http-port 指定"); }
    }

    // 磁盘上的插件版本 vs 宿主进程里**真正加载**的版本。
    //
    // 注意不能用 status.plugin_version 做判据：那是每次请求读盘的
    // updater.localVersion()，反映"磁盘上装了什么"，装完没重启时它立刻就是新版本，
    // 拿它比等于自己跟自己比。用 boot_version —— 它在 import 时抓一次，
    // 进程里跑的是哪版就永远是哪版。
    const running = liveStatus && (liveStatus.boot_version || "");
    if (running && selfPkg?.version) {
      if (String(running) !== String(selfPkg.version)) {
        rec("WARN", "live.versionMatch",
          `disk=${selfPkg.version} running=${running}`,
          "磁盘上的插件已更新但宿主还在跑旧版：重启宿主后才生效");
      } else {
        rec("PASS", "live.versionMatch", `disk=${selfPkg.version} running=${running}`);
      }
    } else if (liveStatus) {
      rec("INFO", "live.versionMatch", "宿主未上报 boot_version（旧版插件），无法判断内存里的版本");
    }
  }

  return emit();
}

function safe(fn) { try { return fn(); } catch { return "(threw)"; } }

function emit() {
  const order = { FAIL: 0, WARN: 1, PASS: 2, INFO: 3 };
  results.sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
  const count = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0 };
  for (const r of results) count[r.level] = (count[r.level] || 0) + 1;

  if (wantJson) {
    process.stdout.write(JSON.stringify({ summary: count, results }, null, 2) + "\n");
  } else {
    const tag = { PASS: "PASS", FAIL: "FAIL", WARN: "WARN", INFO: "info" };
    for (const r of results) {
      process.stdout.write(`[${tag[r.level]}] ${r.id.padEnd(24)} ${r.detail}\n`);
      if (r.hint) process.stdout.write(`       ${" ".repeat(24)} -> ${r.hint}\n`);
    }
    process.stdout.write(`\nsummary: ${count.PASS} pass / ${count.FAIL} fail / ${count.WARN} warn\n`);
  }
  process.exit(count.FAIL > 0 ? 1 : count.WARN > 0 ? 2 : 0);
}

main().catch((e) => {
  process.stderr.write("selfcheck crashed: " + (e && e.stack ? e.stack : e) + "\n");
  process.exit(1);
});
