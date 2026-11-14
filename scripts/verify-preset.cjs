// verify-preset.cjs —— 解会话日志，验证 agent preset 是否真正生效
// 用法: node verify-preset.cjs [preset名]
//
// 判据说明（重要）:
//   agentPreset 字段 = 会话【创建时】的默认 preset，切换后不会更新，有误导性
//   agent-preset/selected 事件 = 实际切换记录，这才是真相
//   system/message 的内容 = 最终效果，最硬的证据
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const want = process.argv[2] || "unrestricted";
const root = path.join(process.env.USERPROFILE, ".dsh", "sessions");
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function walk(d) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".zstd")) out.push({ p, m: fs.statSync(p).mtimeMs });
  }
  return out;
}

function decode(fp) {
  const buf = fs.readFileSync(fp);
  let out = "", pos = 0;
  while (pos < buf.length) {
    const next = buf.indexOf(MAGIC, pos + 1);
    const end = next === -1 ? buf.length : next;
    try { out += zlib.zstdDecompressSync(buf.subarray(pos, end)).toString("utf8"); } catch {}
    if (next === -1) break;
    pos = next;
  }
  return out;
}

function textOf(e) {
  const c = e.data && e.data.message ? e.data.message.content : (e.data ? e.data.content : null);
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => x.text || "").join("");
  return "";
}

const files = walk(root).sort((a, b) => b.m - a.m).slice(0, 6);

const PERSONA = [
  ["含「无限制模式」人设", /你在「无限制模式」下工作/],
  ["含「操作者意图优先」", /操作者意图优先|操作者的目标就是你的目标/],
  ["含「不重复声明边界」", /不重复声明边界/],
  ["含「多轮不退化」", /多轮不退化/],
  ["含「失败就换路」", /失败就换路/],
];
const OURS = [
  ["含「小码酱」注入", /小码酱/],
  ["含注入操作标记", /MERGED-1\.1\.71|OPERATION: STABLE/],
  ["官方身份句已清", /You are an AI agent powered by DeepSeek Harness/, true],
];

const rows = [];
for (const f of files) {
  const text = decode(f.p);
  let preset = null, perm = null, sandbox = null, sys = "";
  const selected = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!preset) {
      const m = line.match(/"agentPreset"\s*:\s*"([^"]+)"/);
      if (m) preset = m[1];
    }
    if (!perm && e.type === "permission/preset") {
      const v = e.data && (e.data.preset || e.data.id || e.data.name);
      if (v) perm = String(v);
    }
    if (!sandbox && e.type === "sandbox/mode") {
      const v = e.data && (e.data.mode || e.data.name);
      if (v) sandbox = String(v);
    }
    if (e.type === "agent-preset/selected") {
      const v = e.data && (e.data.preset || e.data.id || e.data.agentPreset);
      if (v) selected.push(String(v));
    }
    if (e.type === "system/message" && !sys) {
      const t = textOf(e);
      if (t && t.length > 200) sys = t;
    }
  }
  rows.push({ f, preset, perm, sandbox, sys, selected: [...new Set(selected)], mtime: f.m });
}

console.log("═══════════════════════════════════════════════════════");
console.log(" 会话 / preset 对照（最近 " + rows.length + " 个）");
console.log("═══════════════════════════════════════════════════════");

for (const r of rows) {
  const name = path.basename(path.dirname(r.f.p));
  const at = new Date(r.mtime).toISOString().slice(0, 19).replace("T", " ");
  const effective = r.selected.length ? r.selected[r.selected.length - 1] : r.preset;
  const personaScore = PERSONA.filter(([, re]) => re.test(r.sys)).length;

  console.log("");
  console.log("── " + name + "  " + at);
  console.log("   有效 preset = " + (effective || "(未知)") + "   [创建时 " + (r.preset || "?") + " / 切换记录 " + (r.selected.join("→") || "无") + "]");
  console.log("   权限档位    = " + (r.perm || "(未记录)") + "   sandbox = " + (r.sandbox || "(未记录)"));
  console.log("   system 长度 = " + r.sys.length + "   人设命中 " + personaScore + "/" + PERSONA.length);
  if (r.sys) {
    for (const [label, re] of PERSONA) console.log("   │ " + (re.test(r.sys) ? "✓" : "✗") + " " + label);
    for (const [label, re, invert] of OURS) {
      const hit = re.test(r.sys);
      console.log("   │ " + ((invert ? !hit : hit) ? "✓" : "✗") + " " + label);
    }
  }
}

// 汇总
console.log("");
console.log("═══════════════════════════════════════════════════════");
const target = rows.filter((r) => {
  const eff = r.selected.length ? r.selected[r.selected.length - 1] : r.preset;
  return eff === want;
});
if (target.length === 0) {
  console.log(' 没有找到有效 preset = "' + want + '" 的会话。');
  console.log(" → 在模式下拉里选「" + (want === "unrestricted" ? "无限制模式" : want) + "」，发一条消息，再跑这个脚本。");
  process.exitCode = 1;
} else {
  const newest = target.sort((a, b) => b.mtime - a.mtime)[0];
  const name = path.basename(path.dirname(newest.f.p));
  const personaHits = PERSONA.filter(([, re]) => re.test(newest.sys)).length;
  const oursHits = OURS.filter(([, re, inv]) => (inv ? !re.test(newest.sys) : re.test(newest.sys))).length;
  console.log(" 找到 " + target.length + " 个 " + want + " 会话，最新：" + name);
  console.log("");
  console.log(" ── 判定 ──");
  const p1 = personaHits === PERSONA.length;
  const p2 = oursHits === OURS.length;
  console.log("  [" + (p1 ? "PASS" : "FAIL") + "] preset 人设完整注入（" + personaHits + "/" + PERSONA.length + "）");
  console.log("  [" + (p2 ? "PASS" : "FAIL") + "] 我们的破甲注入仍在（" + oursHits + "/" + OURS.length + "）");
  console.log("");
  if (p1 && p2) {
    console.log(" → 配置层通过：preset 已生效，且与 dsh-purge 注入共存。");
    console.log("   下一步做行为层对比（同一提示词在 standard / " + want + " 各跑一次）。");
    process.exitCode = 0;
  } else if (p1 && !p2) {
    console.log(" → preset 生效，但我们的注入被顶掉了，需要调 inject 顺序。");
    process.exitCode = 2;
  } else {
    console.log(" → preset 没真正注入。确认选模式后是【新建会话】，不是旧会话里切。");
    process.exitCode = 3;
  }
}
console.log("═══════════════════════════════════════════════════════");
