/**
 * 2.3.0 观测层测试：飞行记录仪 / 预检分桶 / 时间线聚合。
 *
 * 这一层的特点是「全部只读、全部不抛」——所以测试的重点不是覆盖率，
 * 而是三件事：判据算得对、异常吞得住、格式化不炸空数据。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  recordAssembly,
  resetRecorder,
  recorderStats,
  snapshotRecords,
  verifyArmor,
  renderVerify,
  closerFollowBytes,
  ownSectionBytes,
  ownSectionOf,
  INJECT_SECTION,
} from "../lib/verify.js";
import { renderPreflight, BUCKETS } from "../lib/preflight.js";
import { renderAudit } from "../lib/audit.js";
import {
  readLogTail,
  parseLines,
  buildTurns,
  analyzeTimeline,
  renderTimeline,
} from "../lib/trace.js";

/** 一个「健康」的装配记录。 */
function healthy(over = {}) {
  return {
    enabled: true,
    redteam: false,
    subagent: false,
    source: "refresh",
    srcTag: "prompt-inject",
    injectBytes: 24000,
    rawBytes: 25000,
    localBytes: 0,
    sections: [{ name: "dsh-purge", text: "<project_instructions>\nbody\n</project_instructions>" }],
    // closerFollow 故意不写：记录仪会自己从 sections 里量，正是要锁住这条推导。
    policy: "always",
    dropBaseline: false,
    cwd: "E:\\test",
    ...over,
  };
}

test("记录仪：健康轮判 live，健康度满分", () => {
  resetRecorder();
  recordAssembly(healthy());
  const out = verifyArmor({ window: 8 });
  assert.equal(out.verdict, "live");
  assert.equal(out.score, 100);
  assert.equal(out.window, 1);
  assert.equal(out.counts.empty, 0);
  assert.equal(out.counts.head_miss, 0);
  assert.deepEqual(out.issues, []);
});

test("记录仪：一次都没调用 → dead，并指出钩子没挂上", () => {
  resetRecorder();
  const out = verifyArmor();
  assert.equal(out.verdict, "dead");
  assert.equal(out.assemble_calls, 0);
  assert.match(out.issues.join("\n"), /钩子一次都没被调用/);
});

test("记录仪：空注入判 degraded，且文本指出四重 fallback 全塌", () => {
  resetRecorder();
  recordAssembly(healthy());
  recordAssembly(healthy({ source: "empty", injectBytes: 0, rawBytes: 0 }));
  const out = verifyArmor({ window: 8 });
  assert.equal(out.verdict, "degraded");
  assert.equal(out.counts.empty, 1);
  assert.ok(out.score < 100);
  assert.match(out.issues.join("\n"), /四重 fallback 全塌/);
});

test("记录仪：全部关闭 → dead", () => {
  resetRecorder();
  recordAssembly(healthy({ enabled: false, source: "disabled", injectBytes: 0 }));
  const out = verifyArmor();
  assert.equal(out.verdict, "dead");
});

test("记录仪：首段不是 dsh-purge → headMiss", () => {
  resetRecorder();
  recordAssembly(healthy({ sections: [{ name: "official", text: "x".repeat(100) }] }));
  const out = verifyArmor();
  assert.equal(out.verdict, "degraded");
  assert.equal(out.counts.head_miss, 1);
  assert.match(out.issues.join("\n"), /首段不是 dsh-purge/);
});

test("记录仪：闭合标签后仍有内容 → afterCloser", () => {
  resetRecorder();
  recordAssembly(healthy({ closerFollow: 64 }));
  const out = verifyArmor();
  assert.equal(out.verdict, "degraded");
  assert.equal(out.counts.after_closer, 1);
  assert.equal(out.last.afterCloser, true);
});

test("记录仪：闭合标签容差 2 B 内不算被包", () => {
  resetRecorder();
  recordAssembly(healthy({ closerFollow: 2 }));
  assert.equal(verifyArmor().verdict, "live");
});

test("记录仪：环形缓冲有界，超出挤掉最旧", () => {
  resetRecorder();
  for (let i = 0; i < 200; i += 1) recordAssembly(healthy({ injectBytes: 1000 + i }));
  const stats = recorderStats();
  assert.equal(stats.kept, stats.capacity);
  assert.equal(stats.calls, 200);
  const snaps = snapshotRecords(999);
  assert.equal(snaps.length, stats.capacity);
  // 保留的必须是最后 capacity 条
  assert.equal(snaps[snaps.length - 1].injectBytes, 1199);
});

test("闭合残留只量自家段：宿主段里的闭合标签不参与", () => {
  // 这一条是回归测试。线上实测：装配结果里 dshpg-capabilities 与宿主段都排在我们后面，
  // 旧实现把全部段拼起来找最后一个 </project_instructions>，量出恒定 6511 B 的假报警。
  const sections = [
    { name: INJECT_SECTION, text: "<project_instructions>\nbody\n</project_instructions>" },
    { name: "dshpg-capabilities", text: "capability protocol without closer" },
    { name: "official", text: "host section\n</project_instructions>\n" + "x".repeat(6511) },
  ];
  // 自家段尾就是闭合标签 → 0；后面那一大坨与注入无关。
  assert.equal(closerFollowBytes(sections), 0);
  assert.equal(ownSectionBytes(sections), "<project_instructions>\nbody\n</project_instructions>".length);
});

test("闭合残留：自家段尾部挂着别的正文时如实报出字节数", () => {
  const tail = "\n\n额外正文被吞进信封";
  const sections = [{ name: INJECT_SECTION, text: `<project_instructions>\nbody\n</project_instructions>${tail}` }];
  assert.equal(closerFollowBytes(sections), tail.length);
});

test("闭合残留：自家段没有闭合标签时返回 -1", () => {
  const sections = [{ name: INJECT_SECTION, text: "<project_instructions>\nbody" }];
  assert.equal(closerFollowBytes(sections), -1);
  const entry = verifyArmorAfter({ sections });
  assert.equal(entry.counts.no_closer, 1);
  assert.equal(entry.counts.after_closer, 0, "无闭合不该被算成尾部被包");
});

test("闭合残留：段名不是 dsh-purge 时退回首段", () => {
  const sections = [{ name: "renamed", text: "<project_instructions>x</project_instructions>" }];
  assert.equal(ownSectionOf(sections).name, "renamed");
  assert.equal(closerFollowBytes(sections), 0);
});

test("闭合残留：空段 / 非数组输入不抛", () => {
  assert.equal(closerFollowBytes(null), -1);
  assert.equal(closerFollowBytes([]), -1);
  assert.equal(closerFollowBytes([{ name: INJECT_SECTION }]), -1);
  assert.equal(ownSectionBytes(undefined), 0);
});

/** 录一轮再取结论，省掉每个用例重复 reset/record。 */
function verifyArmorAfter(rec, options) {
  resetRecorder();
  recordAssembly(healthy(rec));
  return verifyArmor(options);
}

test("记录仪：脏输入不抛", () => {
  resetRecorder();
  assert.doesNotThrow(() => recordAssembly(null));
  assert.doesNotThrow(() => recordAssembly({ sections: [null, 42, "x"] }));
  assert.doesNotThrow(() => recordAssembly({ injectBytes: NaN, closerFollow: "abc" }));
  assert.equal(verifyArmor().verdict, "dead");
});

test("记录仪：注入来源分层统计", () => {
  resetRecorder();
  recordAssembly(healthy({ source: "refresh" }));
  recordAssembly(healthy({ source: "hung" }));
  recordAssembly(healthy({ source: "sealed" }));
  const out = verifyArmor();
  assert.equal(out.tiers.refresh, 1);
  assert.equal(out.tiers.hung, 1);
  assert.equal(out.tiers.sealed, 1);
});

test("renderVerify：无数据也给出可读结论", () => {
  resetRecorder();
  const text = renderVerify(verifyArmor());
  assert.match(text, /破甲飞行记录/);
  assert.match(text, /破甲未生效/);
});

test("renderVerify：健康轮显示生效与健康度", () => {
  resetRecorder();
  recordAssembly(healthy());
  const text = renderVerify(verifyArmor());
  assert.match(text, /破甲生效/);
  assert.match(text, /100\/100/);
  assert.match(text, /dsh-purge/);
});

test("预检：没有宿主目录时说明原因，不假报干净", () => {
  const text = renderPreflight({
    ok: false,
    reason: "no_ai_base",
    ai_base: "",
    total: 82,
    buckets: {},
    byLayer: {},
    drift: [],
    forecast: { applied: 0, already: 0, willFail: 0 },
    verdict: "unknown",
    notes: ["没定位到宿主"],
  });
  assert.match(text, /无法判定/);
  assert.match(text, /补丁总数: 82/);
});

test("预检：漂移条目带出锚点前缀", () => {
  const text = renderPreflight({
    ok: true,
    ai_base: "C:\\app",
    total: 3,
    buckets: { applied: 1, pending: 1, unmatched: 1 },
    byLayer: { "代码/Code": { total: 3, applied: 1, pending: 1, unmatched: 1 } },
    drift: [{ id: 7, name: "SANDBOX_MODE_DEFAULT", layer: "代码/Code", desc: "沙箱默认", anchors: ['const SANDBOX_MODE_DEFAULT = "workspac'] }],
    forecast: { applied: 1, already: 1, willWrite: 1, willFail: 1 },
    verdict: "drift",
    notes: ["1 条锚点在当前宿主上找不到"],
  });
  assert.match(text, /存在锚点漂移/);
  assert.match(text, /\[#7\] SANDBOX_MODE_DEFAULT/);
  assert.match(text, /锚点: const SANDBOX_MODE_DEFAULT/);
});

test("预检：桶标签覆盖全部已知状态", () => {
  const keys = BUCKETS.map((b) => b.key);
  for (const k of ["applied", "pending", "unmatched", "skipped", "missing_file", "na"]) {
    assert.ok(keys.includes(k), `缺少桶 ${k}`);
  }
});

test("时间线：解析 k=v 行，值里含等号也切得对", () => {
  const events = parseLines(
    '2026-11-07T10:00:00.000Z [assemble.entry] hasNext=true sections=3 events=5\n' +
    '2026-11-07T10:00:00.100Z [inject.read] source=refresh outBytes=24000\n',
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].tag, "assemble.entry");
  assert.equal(events[0].kv.hasNext, "true");
  assert.equal(events[1].kv.outBytes, "24000");
});

test("时间线：按轮聚合，inject.read 与 rewrite 归入同一轮", () => {
  const events = parseLines(
    'T0 [assemble.entry] hasNext=true\n' +
    'T0 [inject.read] source=refresh outBytes=24000\n' +
    'T0 [assemble.rewrite] injectBytes=24000 injectHead=true afterCloser=0\n' +
    'T1 [assemble.entry] hasNext=true\n' +
    'T1 [inject.read] source=empty outBytes=0\n' +
    'T1 [host.hungFn] tier=empty bytes=0\n',
  );
  const turns = buildTurns(events);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].collapsed, false);
  assert.equal(turns[0].headMiss, false);
  assert.equal(turns[1].collapsed, true);
});

test("时间线：首段丢失被标出", () => {
  const turns = buildTurns(parseLines(
    'T0 [assemble.entry] hasNext=true\n' +
    'T0 [assemble.rewrite] injectBytes=100 injectHead=false afterCloser=0\n',
  ));
  assert.equal(turns[0].headMiss, true);
});

test("时间线：日志不存在时 ok=false 且说明原因", () => {
  const result = analyzeTimeline({ logPath: path.join(os.tmpdir(), "definitely-not-here-9f3a.log") });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_log");
  const text = renderTimeline(result);
  assert.match(text, /无日志/);
});

test("时间线：真实文件端到端，塌陷轮被计数", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-trace-"));
  const logPath = path.join(dir, "dsh-purge-desktop.log");
  const lines = [
    "2026-11-07T10:00:00.000Z [assemble.entry] hasNext=true sections=3 events=1",
    "2026-11-07T10:00:00.001Z [inject.read] source=refresh outBytes=24000",
    "2026-11-07T10:00:00.002Z [assemble.rewrite] injectBytes=24000 injectHead=true afterCloser=0",
    "2026-11-07T10:01:00.000Z [assemble.entry] hasNext=true sections=3 events=3",
    "2026-11-07T10:01:00.001Z [inject.read] source=empty outBytes=0",
    "2026-11-07T10:01:00.002Z [host.hungFn] tier=empty bytes=0",
    "",
  ];
  fs.writeFileSync(logPath, lines.join("\n"), "utf8");
  try {
    const result = analyzeTimeline({ logPath, window: 10 });
    assert.equal(result.ok, true);
    assert.equal(result.totals.turns, 2);
    assert.equal(result.totals.collapsed, 1);
    assert.equal(result.totals.hungEmpty, 1);
    assert.match(renderTimeline(result), /塌陷 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("时间线：尾部读取丢弃半截首行", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-tail-"));
  const logPath = path.join(dir, "log.txt");
  // A×100 + \n + 一行完整事件（约 33 B）。窗口取 60 B：起点落在 A 串中间，
  // 于是首行必然是半截 "AAAA…"，实现应把它丢掉，只留完整的那条事件。
  fs.writeFileSync(logPath, "A".repeat(100) + "\nT0 [assemble.entry] hasNext=true\n", "utf8");
  try {
    const tail = readLogTail(logPath, 60);
    assert.equal(tail.truncated, true);
    assert.ok(!tail.text.startsWith("A"), "半截首行应被丢弃");
    assert.match(tail.text, /assemble\.entry/);
    // 丢掉首行后，剩下的必须是一整行可解析事件。
    const events = parseLines(tail.text);
    assert.equal(events.length, 1);
    assert.equal(events[0].tag, "assemble.entry");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("时间线：窗口小到装不下任何完整行时返回空，不吐半截", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "purge-tail2-"));
  const logPath = path.join(dir, "log.txt");
  fs.writeFileSync(logPath, "A".repeat(100) + "\nT0 [assemble.entry] hasNext=true\n", "utf8");
  try {
    // 30 B 的窗口只覆盖到 T0 行的中段，丢弃半截后应当无内容，而不是返回残缺行。
    const tail = readLogTail(logPath, 30);
    assert.equal(tail.text, "");
    assert.equal(parseLines(tail.text).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("入口与 audit 可加载：语法与内部引用完整", async () => {
  const entry = await import("../lib/index.js");
  assert.equal(entry.name, "dsh-purge");
  assert.ok(Array.isArray(entry.inject));
  assert.equal(typeof entry.registerPromptSections, "function");

  const auditMod = await import("../lib/audit.js");
  assert.equal(typeof auditMod.runAudit, "function");
  assert.equal(typeof auditMod.renderAudit, "function");
});

test("renderAudit：无运行时数据时给出「还没跑过一轮」而不是判红", () => {
  const text = renderAudit({
    version: "2.3.0",
    dsh_home: "C:\\dsh",
    passed: 11,
    total: 11,
    full_break: true,
    checks: [{ id: "attack_off", label: "攻击任务检测已关闭", ok: true, detail: "含 100pct 标记" }],
    runtime: { verdict: "dead", score: 100, window: 0, counts: {}, tiers: {}, issues: [] },
    timeline: null,
  });
  assert.match(text, /源码层 \/ source: 11\/11 通过/);
  assert.match(text, /运行时层 \/ runtime/);
  assert.match(text, /还没有装配记录/);
});
