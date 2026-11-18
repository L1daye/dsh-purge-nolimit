#!/usr/bin/env node

import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";
import * as diagnose from "../lib/diagnose.js";
import * as anchors from "../lib/anchors.js";

const args = process.argv.slice(2);

function printStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push("  宿主 / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  if (state.desktop_install) out.push("  桌面安装       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  插件根 / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  插件根 / root  " + core.missingAiBaseMessage());
  }
  out.push(`  shim 目录      ${state.shim_dir || "未定位 / not found"}`);
  out.push(`  备份 / backup  ${state.has_backup ? "有 / yes" : "无 / no"}`);
  out.push(`  注入文件       ${state.override_path}`);
  out.push(`  注入状态       ${state.override_status}`);
  out.push("");
  out.push(`  补丁 ${state.patches_applied}/${core.ALL_PATCHES.length} 已清洗, ${state.patches_pending} 待清洗`);
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

// ── diagnose / reanchor ──────────────────────────────────────────────
//
// 宿主升级后锚点会漂移。`--diagnose` 说清楚哪条、哪个文件、第几个 anchor
// 失配，并从锚点里挑一个辨识片段去宿主文件里搜出候选行号；
// `--reanchor` 把用户确认的那段真实代码写成覆盖（不改插件源码）。

async function runDiagnose(state, json) {
  if (!state.ai_base) {
    console.log("[ERROR] " + core.missingAiBaseMessage());
    process.exit(1);
  }
  const fsmod = (await import("node:fs")).default;
  // 只诊断**没打上**的补丁：已经 applied 的补丁锚点本来就该消失，
  // 把它们也列出来只会把真漂移埋在噪声里。
  // 可选补丁的 `skipped` 也要排掉——那是"前端 bundle 重新压缩、标记不再出现"这类
  // 设计内的软跳过，不是需要重锚的漂移。
  const status = await core.patchStatus(state.ai_base, core.ALL_PATCHES);
  const pending = core.ALL_PATCHES.filter((p) => {
    const s = status[p.id];
    if (s === "applied" || s === "na") return false;
    if (s === "skipped" && p.optional === true) return false;
    return true;
  });
  const rows = diagnose.diagnoseAnchors(state.ai_base, pending, {
    targetFiles: core.targetFiles,
    readFileSafe: (fp) => {
      try { return fsmod.readFileSync(fp, "utf8"); } catch { return null; }
    },
    patchReplacements: core.patchReplacements,
    matchesPattern: core.matchesPattern,
  });
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(diagnose.renderDiagnosis(rows));
  if (rows.length) {
    console.log("落地后用 --apply 应用，然后重启 dsh。覆盖存在：");
    console.log("  " + anchors.OVERRIDES_FILE + "（删掉即恢复出厂锚点）");
  }
}

async function runReanchor(state, argv) {
  const rest = argv.slice(argv.indexOf("--reanchor") + 1).filter((a) => !a.startsWith("--"));
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : "";
  };
  const yes = argv.includes("--yes");

  if (rest[0] === "clear") {
    const id = rest[1];
    if (!id) { console.log("用法: dsh-purge --reanchor clear <id>"); process.exit(2); }
    anchors.clearOverride(state.dsh_home, id);
    core.invalidateAnchorOverrides();
    console.log(`✓ 已清除 #${id} 的本地重锚覆盖`);
    return;
  }

  const id = rest[0];
  const index = Number(flag("--index") || 0);
  const lines = String(flag("--lines") || "");
  if (!id) {
    console.log(`用法:
  dsh-purge --diagnose                                   查看漂移与候选行
  dsh-purge --reanchor <id> --index <n> --lines A-B      预览（不写盘）
  dsh-purge --reanchor <id> --index <n> --lines A-B --yes  落盘
  dsh-purge --reanchor clear <id>                        撤销覆盖`);
    process.exit(2);
  }
  const patch = core.ALL_PATCHES.find((p) => String(p.id) === String(id));
  if (!patch) { console.log(`没有 #${id} 这条补丁`); process.exit(2); }
  const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
  const files = core.targetFiles(state.ai_base);
  const target = keys.flatMap((k) => {
    const v = files[k];
    return Array.isArray(v) ? v : v ? [v] : [];
  })[0];
  if (!target) { console.log(`#${id} 的目标文件在本机不存在`); process.exit(2); }
  if (!/^\d+-\d+$/.test(lines)) { console.log("--lines 需要形如 120-138"); process.exit(2); }
  const [a, b] = lines.split("-").map(Number);
  const pattern = diagnose.extractLines(target, a, b);
  if (!pattern.trim()) { console.log("取到的区间是空的"); process.exit(2); }

  console.log(`#${id} ${patch.name}  anchor#${index}  ←  ${target}`);
  console.log("--- 新锚点 ---");
  console.log(pattern);
  console.log("--------------");
  if (!yes) {
    console.log("预览模式，未写盘。确认无误加 --yes。");
    return;
  }
  anchors.writeOverride(state.dsh_home, id, index, pattern, { host: patch.name });
  core.invalidateAnchorOverrides();
  console.log("✓ 已写入本地重锚覆盖。接着 --apply 应用，然后重启 dsh。");
}

async function main() {
  const mode = args.find((a) =>
    ["--apply", "--revert", "--uninstall", "--status", "--edit", "--help", "--diagnose", "--reanchor"].includes(a)
  );

  if (mode === "--help" || args.includes("-h")) {
    console.log(`dsh-purge 用法:
  dsh-purge --status     显示状态（加 --json 输出结构化版本）
  dsh-purge --apply      应用全部清洗（提示词+代码+shim+override）
  dsh-purge --revert     回滚还原
  dsh-purge --uninstall  卸载插件（已应用则先还原）
  dsh-purge --edit       编辑注入文件 prompt-inject.md
  dsh-purge --diagnose   锚点漂移诊断（含候选行号）
  dsh-purge --reanchor   本地重锚（不改插件源码）
  dsh-purge --help       帮助`);
    return;
  }

  const state = await core.gatherState();
  // --json 是给机器读的：不能先泼一段人读的状态再打 JSON，
  // 否则调用方（脚本、探针）没法直接 JSON.parse 整个 stdout。
  if (!args.includes("--json")) {
    console.log(printStatus(state));
    console.log("");
  }

  if (mode === "--apply") {
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: 把 DSH_BASE 指到含 dsh-agent-instructions/lib 的 @deepseek-ai 目录");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] 提示词和规则集都是空的，必须先添加提示词");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  宿主 / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  多宿主 / multi-host: ${hosts.length} 份 @deepseek-ai 已清洗`);
    }
    console.log(inject.source === "rule"
      ? "  - 使用当前规则集，不改写提示词文件"
      : "  - 使用已有提示词文件");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} 注入 / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} 已注入 / already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} 不存在 / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ 未定位 shim 目录，跳过注入");
    }
    console.log("");
    console.log("全部完成 / All done。重启 dsh 生效 / Restart dsh to take effect.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ 已还原 / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ 还原失败 ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - 没有补丁备份可还原 / no patch backup");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
    console.log("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  已检测到补丁，已还原回原版。");
    else console.log("  未检测到已应用补丁，仍会清除插件文件。");
    if (result.override?.removed) console.log(`  已删除 ${result.override.path}`);
    if (result.stripped?.length) console.log(`  已从 profile 移除: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  卸载中止：还原失败，插件文件未删除。");
      process.exit(1);
    }
    console.log("");
    console.log("卸载完成。请重启 dsh。");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ 已创建默认注入文件：${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → 已打开 ${r.editor} 编辑注入文件：${r.path}`);
    }
    console.log("  编辑完成后重启 dsh 生效。");
  } else if (mode === "--diagnose") {
    await runDiagnose(state, args.includes("--json"));
  } else if (mode === "--reanchor") {
    await runReanchor(state, args);
  } else if (mode === "--status") {
    // 人读版已经由上面的 printStatus 打过；--json 时补一份结构化版本。
    // 之前 --status 没有独立分支，掉进最后的 else，于是 `--status --json`
    // 只输出一句「默认不清洗」，机器读不到任何东西。
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  } else {
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    else console.log("默认不清洗，使用 --apply 应用清洗。");
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
