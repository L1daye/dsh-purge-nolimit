// 移植模块的回归测试。
//
// 覆盖 2.3.36 从 kingcharleslzy-ai/dsh-purge 搬进来的模块：
// layers（语义分层）、verifiers（语义验证）、anchors（本地重锚）、
// diagnose（漂移诊断）、safeArchiveName（zip-slip）、logAudit（动作审计）。
//
// 这些模块的共同点是"错了不会抛异常，只会静默给错结论"，所以每个都要有
// 正反两面的断言，不能只测 happy path。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BYPASS_LAYERS, rollupLayers, renderLayers, checkLayerCoverage } from "../lib/layers.js";
import {
  VERIFIERS,
  REQUIRE_ALL_TARGETS,
  verifyOfficialToolAskFailOpen,
  verifyEscalationNeverReject,
  verifyFsFenceDisabled,
  verifySandboxConfinePassthrough,
} from "../lib/verifiers.js";
import {
  OVERRIDES_FILE,
  readOverrides,
  writeOverride,
  clearOverride,
  applyOverrides,
} from "../lib/anchors.js";
import { pickToken, extractLines, renderDiagnosis } from "../lib/diagnose.js";
import { safeArchiveName } from "../lib/zip-extract.js";
import { logAudit, readAudit, auditPath } from "../lib/audit.js";
import { ALL_PATCHES } from "../lib/core.js";

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "purge-port-"));

// ── layers ──────────────────────────────────────────────────────────

test("layers: 每条补丁都落在某一层（漏一条就会在面板上凭空消失）", () => {
  const cov = checkLayerCoverage(ALL_PATCHES);
  assert.deepEqual(cov.missing, []);
  assert.deepEqual(cov.ghost, []);
  assert.equal(cov.ok, true);
});

test("layers: 层 id 不重复（同一补丁出现在两层会互相打架）", () => {
  const seen = new Set();
  for (const l of BYPASS_LAYERS) {
    for (const id of l.ids) {
      assert.equal(seen.has(id), false, `#${id} 出现了两次`);
      seen.add(id);
    }
  }
});

test("layers: optionalIds 必须是本层 ids 的子集（否则那条从来没被计入）", () => {
  for (const l of BYPASS_LAYERS) {
    const own = new Set(l.ids);
    for (const id of l.optionalIds || []) {
      assert.ok(own.has(id), `#${id} 在 ${l.title} 的 optionalIds 里但不在 ids 里`);
    }
  }
});

test("layers: 全部 applied → ok；有 pending → pending；有 failed → broken", () => {
  const patches = [
    { id: 1, name: "A" },
    { id: 2, name: "B" },
  ];
  const layer = BYPASS_LAYERS.find((l) => l.ids.includes(1));
  assert.ok(layer, "需要至少一层包含 #1");
  const all = {};
  for (const id of layer.ids) all[id] = "applied";

  const ok = rollupLayers(all, patches).find((l) => l.title === layer.title);
  assert.equal(ok.state, "ok");

  const pend = rollupLayers({ ...all, 1: "pending" }, patches).find((l) => l.title === layer.title);
  assert.equal(pend.state, "pending");
  assert.ok(pend.pendingIds.includes("1"));

  const broken = rollupLayers({ ...all, 1: "failed" }, patches).find((l) => l.title === layer.title);
  assert.equal(broken.state, "broken");
});

test("layers: na 不计入分母（目标包没装不算缺陷）", () => {
  const layer = BYPASS_LAYERS.find((l) => l.ids.length === 1);
  const id = layer.ids[0];
  const rolled = rollupLayers({ [id]: "na" }, [{ id, name: "X" }]).find((l) => l.title === layer.title);
  assert.equal(rolled.state, "na");
  assert.equal(rolled.total, 0);
});

test("layers: renderLayers 对非 ok 层给出待应用 id 与影响说明", () => {
  const rolled = [
    { title: "T", kind: "k", why: "因为这样", state: "pending", applied: 1, total: 2, optional: 0, pendingIds: ["62"], brokenIds: [], naIds: [] },
  ];
  const text = renderLayers(rolled);
  assert.match(text, /#62/);
  assert.match(text, /因为这样/);
});

// ── verifiers ───────────────────────────────────────────────────────

test("verifiers: #62 认得出残留的 deny 分支（marker 在也不行）", () => {
  const good =
    'if (approval === void 0) return { decision: { kind: "allow" }, approvalCancelled: false }; // [dsh-purge] no approval service → allow\n' +
    "case \"unavailable\": return { decision: { kind: \"allow\" }, approvalCancelled: false };\n";
  assert.equal(verifyOfficialToolAskFailOpen(good), true);

  // marker 命中，但同文件里还有没改的 deny 分支 —— 正是 2.3.32 的事故形态
  const halfBroken = good + 'if (exec.agent === void 0) return {\n\tdecision: {\n\t\tkind: "deny",\n\t\treason: "x"\n\t}\n};\n';
  assert.equal(verifyOfficialToolAskFailOpen(halfBroken), false);

  // 压根没有这段代码的文件（rc.3 把决策体搬去了 pipeline.js）视为达标，
  // 否则配合 requireAllTargets 会把"无可改之处"误判成未达标。
  assert.equal(verifyOfficialToolAskFailOpen("nothing here"), true);
});

test("verifiers: #62 认 rc.3 的 approvalDenial 形态", () => {
  const bad = "[dsh-purge] no approval service → allow\ncase \"unavailable\": return { decision: approvalDenial(`x`, Y), approvalCancelled: false };\n";
  assert.equal(verifyOfficialToolAskFailOpen(bad), false);
});

test("verifiers: #35 只要还有 rejected/cancelled 抛错就不算达标", () => {
  const good = "// [dsh-purge] escalation never rejected\nswitch (x) { case \"allowed-once\": default: return mode; }";
  assert.equal(verifyEscalationNeverReject(good), true);
  const bad = good + '\ncase "rejected": throw new Error("no");';
  assert.equal(verifyEscalationNeverReject(bad), false);
});

test("verifiers: #16 只要还能抛 FS_SANDBOX_DENIED 就不算达标", () => {
  const good = "// [dsh-purge] filesystem sandbox bypass\nreturn target;";
  assert.equal(verifyFsFenceDisabled(good), true);
  assert.equal(verifyFsFenceDisabled(good + '\nthrow new FsError("no", "FS_SANDBOX_DENIED");'), false);
});

test("verifiers: #15 只看 confine() 体内，不误伤同类定义", () => {
  const good =
    "confine(argv, policy) {\n\t// [dsh-purge] sandbox bypass\n\treturn {\n\t\targv: [...argv],\n\t\tdenialSignatures: [],\n\t\trunnerFailureRules: []\n\t};\n}\n" +
    "runnerArgv(runner, policy) { return [\"bwrap\", ...bwrapProfileArgs(policy)]; }";
  // runnerArgv 里还有 bwrapProfileArgs，但 confine 已经不用它 → 达标
  assert.equal(verifySandboxConfinePassthrough(good), true);

  const bad = "confine(argv, policy) {\n\t// [dsh-purge] sandbox bypass\n\treturn { denialSignatures: DENIAL_SIGNATURES };\n}";
  assert.equal(verifySandboxConfinePassthrough(bad), false);
});

test("verifiers: 只给有事故史的补丁挂验证器，且都在补丁表里", () => {
  const ids = new Set(ALL_PATCHES.map((p) => p.id));
  for (const id of Object.keys(VERIFIERS).map(Number)) assert.ok(ids.has(id), `#${id} 不在 ALL_PATCHES`);
  for (const id of REQUIRE_ALL_TARGETS) assert.ok(ids.has(id), `#${id} 不在 ALL_PATCHES`);
  for (const p of ALL_PATCHES) {
    if (VERIFIERS[p.id]) assert.equal(p.verify, VERIFIERS[p.id]);
    if (REQUIRE_ALL_TARGETS.includes(p.id)) assert.equal(p.requireAllTargets, true);
  }
});

// ── anchors ─────────────────────────────────────────────────────────

test("anchors: 写 / 读 / 清 一趟，文件权限 0600", () => {
  const home = tmpHome();
  writeOverride(home, 24, 0, "PATTERN");
  const ov = readOverrides(home);
  assert.equal(ov["24"]["0"].pattern, "PATTERN");
  const fp = path.join(home, "dsh-purge", OVERRIDES_FILE);
  assert.ok(fs.existsSync(fp));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(fp).mode & 0o777, 0o600);
  }
  clearOverride(home, 24);
  assert.deepEqual(readOverrides(home), {});
});

test("anchors: applyOverrides 只换 pattern，不动 replace，且不改原对象", () => {
  const patch = { id: 7, replacements: [{ pattern: "OLD", replace: "NEW" }, { pattern: "OLD2", replace: "NEW2" }] };
  const out = applyOverrides(patch, { 7: { 1: { pattern: "FRESH" } } });
  assert.equal(out.replacements[1].pattern, "FRESH");
  assert.equal(out.replacements[1].replace, "NEW2");
  assert.equal(out.replacements[0].pattern, "OLD");
  assert.equal(patch.replacements[1].pattern, "OLD2", "原对象不应被修改");
  assert.equal(out.overridden, true);
});

test("anchors: 覆盖 index 越界时原样返回", () => {
  const patch = { id: 7, replacements: [{ pattern: "OLD", replace: "NEW" }] };
  assert.equal(applyOverrides(patch, { 7: { 5: { pattern: "X" } } }), patch);
});

// ── diagnose ────────────────────────────────────────────────────────

test("diagnose: 从锚点里挑出辨识度最高的片段", () => {
  assert.equal(pickToken('throw new Error(`no approval channel is available`)'), "no approval channel is available");
  assert.equal(pickToken('foo("a-long-quoted-string", bar)'), "a-long-quoted-string");
  assert.equal(pickToken("no quotes at all"), "");
});

test("diagnose: extractLines 按 1-based 闭区间取行，越界自动夹住", () => {
  const home = tmpHome();
  const fp = path.join(home, "x.js");
  fs.writeFileSync(fp, "L1\nL2\nL3\nL4\n");
  assert.equal(extractLines(fp, 2, 3), "L2\nL3");
  assert.equal(extractLines(fp, 3, 2), "L2\nL3", "逆序也要能取");
  assert.equal(extractLines(fp, 1, 99), "L1\nL2\nL3\nL4");
});

test("diagnose: 无漂移时报告是一句人话而不是空串", () => {
  assert.match(renderDiagnosis([]), /没有锚点漂移/);
});

// ── zip-slip ────────────────────────────────────────────────────────

test("safeArchiveName: 放行正常相对路径", () => {
  assert.equal(safeArchiveName("a/b.txt"), "a/b.txt");
  assert.equal(safeArchiveName("./a/b.txt"), "a/b.txt");
  assert.equal(safeArchiveName("a\\b.txt"), "a/b.txt");
});

test("safeArchiveName: 拒绝绝对路径、盘符、上跳、保留设备名、点/空格结尾", () => {
  for (const bad of ["../evil", "/etc/passwd", "C:\\x", "con.txt", "aux", "a.", "a ", "x/\x01y"]) {
    assert.throws(() => safeArchiveName(bad), /不合法/, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

// ── audit ───────────────────────────────────────────────────────────

test("audit: 写一行读一行，字段完整", () => {
  const home = tmpHome();
  assert.equal(logAudit("apply", { patches: 3 }, home), true);
  const rows = readAudit({ limit: 10, home });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "apply");
  assert.equal(rows[0].patches, 3);
  assert.ok(rows[0].at);
  assert.ok(fs.existsSync(auditPath(home)));
});

test("audit: 文件不存在时读回空数组（不抛）", () => {
  assert.deepEqual(readAudit({ home: tmpHome() }), []);
});

test("audit: 写不进去返回 false 而不是抛（审计失败不该拖垮 apply）", () => {
  // 指向一个不可能建目录的路径：用一个文件当父目录
  const home = tmpHome();
  const blocker = path.join(home, "dsh-purge");
  fs.writeFileSync(blocker, "not a dir");
  assert.equal(logAudit("apply", {}, home), false);
});
