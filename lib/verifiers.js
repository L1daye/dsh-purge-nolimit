/**
 * 补丁语义验证 / semantic patch verifiers.
 *
 * 为什么需要这一层：`markers` 只能证明"这一处文本被改过"，不能证明**整个文件**达标。
 * 真实事故：#62 在 `dsh-tools/lib/pipeline.js` 里因为 `case "unavailable"` 命中了
 * marker 就被判 `applied`，而同一个文件的
 *
 *     if (approval === void 0) return { decision: { kind: "deny", ... } }
 *     if (exec.agent === void 0) return { decision: { kind: "deny", ... } }
 *
 * 两个 fail-open 分支一直没改。配合 `skipIfMarked`，重装也永远收敛不了。
 *
 * 做法借自 kingcharleslzy-ai/dsh-purge 的 `nativeSteeringRestored()`：
 * 给补丁挂一个 `verify(text, fp)`，engine 里 `filePatchSettled()` 见到它就
 * **完全绕开 marker 判定**，由验证函数说了算；验证不通过且没有残留锚点 →
 * 报 `unmatched`（漂移），不再当"可选跳过"。
 *
 * 约定：
 *   - 只在该补丁自己的目标文件上调用。
 *   - 返回 `true` 表示这个文件达标；`false` 表示没达标（含抛错）。
 *   - 不做"部分达标"的宽容：宁可报红，也不要有色眼镜。
 */

/** 文本归一化：CRLF → LF，避免同一段代码因换行符被判成两种形态。 */
function norm(text) {
  return String(text || "").replace(/\r\n/g, "\n");
}

// ── #62 OFFICIAL_TOOL_ASK_FAILOPEN ───────────────────────────────────
//
// 必须同时满足：
//   ① 文件里有本补丁写过的标记（证明我们确实动过它，不是全新文件）
//   ② 四个 fail-open 分支一个都不剩：
//        approval === void 0 / undefined   → 不能返回 deny
//        exec.agent === void 0 / undefined → 不能返回 deny
//        case "unavailable"                → 不能返回 deny 或 approvalDenial
//   ③ 用户主动拒绝 / 取消仍然保持 deny（这不是缺陷，是设计）


// 四种缩进/引号布局 × 两个判空条件。只认"返回 deny"的形态，返回 allow 的不算。
const P62_DENY_FORMS = [
  // tab 缩进 + 双引号 + 单行 return
  /if \(approval === (?:void 0|undefined)\) return \{\s*\n?\s*decision: \{\s*\n?\s*kind: "deny"/,
  /if \(exec\.agent === (?:void 0|undefined)\) return \{\s*\n?\s*decision: \{\s*\n?\s*kind: "deny"/,
  // 4/8 空格缩进 + 单引号 + 多行 return
  /if \(approval === (?:void 0|undefined)\) \{\s*\n?\s*return \{\s*\n?\s*decision: \{ kind: 'deny'/,
  /if \(exec\.agent === (?:void 0|undefined)\) \{\s*\n?\s*return \{\s*\n?\s*decision: \{ kind: 'deny'/,
  // case "unavailable" 直接 deny
  /case ['"]unavailable['"]:\s*return \{\s*\n?\s*decision: \{\s*\n?\s*kind: ["']deny["']/,
  // rc.3 起 deny 收敛成 approvalDenial(reason, code)
  /case ['"]unavailable['"]:\s*return \{\s*\n?\s*decision: approvalDenial\(/,
];

export function verifyOfficialToolAskFailOpen(text) {
  const src = norm(text);
  // 判据只有一条：这个文件里不能再有 fail-open 分支返回 deny。
  //
  // 不要求 marker 的原因：#62 的目标文件在不同宿主版本上并不相同——
  // rc.3 把审批决策体搬进了 dsh-tools/lib/pipeline.js，而 dsh-tools/lib/index.js
  // 和 types/index.js 里根本没有这段代码。若坚持"必须有 marker"，
  // 配合 requireAllTargets 会把"这个文件压根没有可改的东西"误判成未达标，
  // 于是 #62 在已经全改好的 rc.3 上永远报 pattern_not_found。
  return !P62_DENY_FORMS.some((re) => re.test(src));
}

// ── #35 ESCALATION_NEVER_REJECT ──────────────────────────────────────
//
// 目标是"升级结果永远授信"：switch 里不能再出现 rejected / cancelled /
// unavailable 抛错。只查授信形态，不管具体错误类型（rc.3 换成了
// SandboxEscalationError，锚点已覆盖，验证器不必重述）。

const P35_MARKER = "[dsh-purge] escalation never rejected";

const P35_THROW_FORMS = [
  /case "rejected":\s*throw new /,
  /case "cancelled":\s*throw new /,
  /case "cancelled":\s*\n\s*approval\.signal\?\.throwIfAborted\(\)/,
  /case "unavailable":\s*throw new /,
];

export function verifyEscalationNeverReject(text) {
  const src = norm(text);
  if (!src.includes(P35_MARKER)) return false;
  return !P35_THROW_FORMS.some((re) => re.test(src));
}

// ── #16 FS_FENCE_DISABLED ────────────────────────────────────────────
//
// 目标是"文件系统围栏不再拒绝"。检查：本补丁的标记在，且文件里不再有
// 因只读/工作区边界直接拒绝的分支。

const P16_MARKERS = ["[dsh-purge] filesystem sandbox bypass"];

const P16_DENY_FORMS = [
  /throw new FsError\([^)]*FS_SANDBOX_DENIED/,
  /"FS_SANDBOX_DENIED"/,
  /'FS_SANDBOX_DENIED'/,
];

export function verifyFsFenceDisabled(text) {
  const src = norm(text);
  if (!P16_MARKERS.some((m) => src.includes(m))) return false;
  return !P16_DENY_FORMS.some((re) => re.test(src));
}

// ── #15 SANDBOX_CONFINE_PASSTHROUGH ──────────────────────────────────
//
// 目标是"命令不再被包进 bwrap / sandbox-exec 等 runner"。
// 检查：标记在，且没有实际的 runner 包装调用残留。

const P15_MARKERS = ["[dsh-purge] sandbox bypass"];

// 达标形状：confine() 直接返回原 argv，denial 签名与 runner 失败规则都清空。
// 判据必须**限定在 confine() 体内**——`bwrapProfileArgs()` 与 `runnerArgv()`
// 在同一个文件里还有定义（以及被别的调用点用），它们存在不代表 confine 没改。
const P15_OK_FORMS = [/denialSignatures:\s*\[\]/, /runnerFailureRules:\s*\[\]/];

const P15_WRAP_FORMS = [
  /denialSignatures:\s*DENIAL_SIGNATURES/,
  /bwrapProfileArgs\(policy\)/,
  /this\.runnerArgv\(/,
];

/** 截出 confine() 的方法体（两种签名都认），用于限定判据范围。 */
function confineBody(src) {
  const at = src.indexOf("confine(argv, policy) {") >= 0
    ? src.indexOf("confine(argv, policy) {")
    : src.indexOf("confine(argv, policy, signal) {");
  if (at < 0) return "";
  // 方法在 class 里，闭合是 1-tab 缩进的 `}`。截到它为止，
  // 否则会把后面的 runnerArgv / bwrapProfileArgs 定义一起吞进来。
  const close = src.indexOf("\n\t}", at);
  return close < 0 ? src.slice(at, at + 900) : src.slice(at, close + 3);
}

export function verifySandboxConfinePassthrough(text) {
  const src = norm(text);
  if (!P15_MARKERS.some((m) => src.includes(m))) return false;
  const body = confineBody(src);
  if (!body) return false;
  if (!P15_OK_FORMS.every((re) => re.test(body))) return false;
  return !P15_WRAP_FORMS.some((re) => re.test(body));
}

/**
 * 给补丁表挂验证器。
 *
 * 只挂"有真实事故史"或"一条 marker 会掩盖多分支"的补丁；
 * 绝大多数补丁用 marker 判定就够了，全挂上来只会让状态噪声变大。
 */
export const VERIFIERS = Object.freeze({
  15: verifySandboxConfinePassthrough,
  16: verifyFsFenceDisabled,
  35: verifyEscalationNeverReject,
  62: verifyOfficialToolAskFailOpen,
});

/**
 * 需要"所有目标文件都达标才算达标"的补丁。
 *
 * 这些补丁都跨多个文件（tools / tools-types / 两份 pipeline.js），
 * 只改中一份就报 applied 是 2.3.32 那次半破的成因。
 */
export const REQUIRE_ALL_TARGETS = Object.freeze([15, 16, 35, 62]);
