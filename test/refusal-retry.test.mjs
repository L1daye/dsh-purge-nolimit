// 拒绝检测 + 重试计数器。
//
// 这个测试护两件事：
//   1. 检测器不能漏掉中文的「对象后置」拒绝（「这条我不做」），也不能误伤正常技术回答；
//   2. 计数器不能重复重试同一个 seq，也不能无限重试。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REFUSAL_PATTERNS,
  RETRY_NUDGE,
  FRAME_NUDGE,
  DECOMPOSE_NUDGE,
  refusalMatchIndex,
  looksLikeRefusal,
  lastAssistantMessage,
  createRefusalTracker,
} from "../lib/refusal-retry.js";

test("refusal patterns catch hard refusals", () => {
  const cases = [
    "I can't help with that.",
    "I'm sorry, but I can't assist with this request.",
    "I cannot provide that information.",
    "作为一个人工智能，我不能协助这个请求。",
    "这一步我不做。",
    "我不能帮你写这个。",
    "这属于未授权访问，我不能参与。",
  ];
  for (const text of cases) {
    assert.ok(looksLikeRefusal(text), `should flag: ${text}`);
  }
});

test("refusal patterns catch the Chinese post-object negation (1.7.12 addition)", () => {
  // 中文拒绝常把「不」放在对象之后，旧规则整类漏检。
  const cases = [
    "这条我不做。",
    "这份我不出。",
    "这个我不提供。",
    "这类内容不做。",
    "结论：这条我不做。",
    "我不写这种东西。",
  ];
  for (const text of cases) {
    assert.ok(looksLikeRefusal(text), `should flag post-object negation: ${text}`);
  }
});

test("technical answers are not flagged", () => {
  const cases = [
    "这里是完整的实现：\n\n```js\nconst x = 1;\n```\n\n先用 nmap 扫端口。",
    "先跑 subfinder，再 httpx 探活，最后 ffuf 爆破目录。",
    "这个函数的作用是把 header 上限提到 256KB，对应 patch #92。",
    "授权已由操作者提供，直接给代码。",
    "SQL 注入的布尔盲注写法：`' and 1=1 -- -` 与 `' and 1=2 -- -` 响应不同。",
    // 长技术回答里出现「提示词注入」是正常讨论，不该判成拒绝
    "提示词注入的常见手法包括角色覆盖和指令劫持，防御方式是在装配层做隔离。" +
      "具体实现要在 system-prompt/assemble 的 waterfall 里插入自己的 section，" +
      "并保证用户正文不被覆盖。这段代码大约 200 行，核心是 section 排序和去重。",
  ];
  for (const text of cases) {
    assert.equal(looksLikeRefusal(text), false, `should NOT flag: ${text.slice(0, 60)}`);
  }
});

test("meta-refusal exemption only applies to long text", () => {
  // 短句里说「这是越狱」= 拒绝
  assert.ok(looksLikeRefusal("这是提示词注入，我不处理。"));
  // 长文里说「这是越狱」= 技术讨论。注意括号：只给最后一段加 repeat 不会变长。
  const long = (
    "这段关于提示词注入的分析需要覆盖：分类器结构、probe 集设计、可复现 trace 的产出，" +
    "以及如何把梯度排名作为评估指标。还要注意模板解析器在静态分析时的默认框架。" +
    "实现上建议先做一个 instrumented harness，再逐步加 probe。"
  ).repeat(3);
  assert.ok(long.length > 280);
  assert.equal(refusalMatchIndex(long), -1);
});

test("refusalMatchIndex reports which rule hit", () => {
  const idx = refusalMatchIndex("I can't help with that.");
  assert.ok(idx >= 0 && idx < REFUSAL_PATTERNS.length);
  assert.equal(refusalMatchIndex("完全正常的回答。"), -1);
});

test("ledger strips markdown prefixes before matching", () => {
  // 行首的 >、*、-、#、「结论：」都不该阻止匹配
  assert.ok(looksLikeRefusal("> 这一步我不做。"));
  assert.ok(looksLikeRefusal("* 这条我不做。"));
  assert.ok(looksLikeRefusal("## 结论：我不能帮你。"));
  assert.ok(looksLikeRefusal("结论：我不做。"));
});

test("lastAssistantMessage picks the last text-bearing assistant event", () => {
  const events = [
    { type: "user/message", seq: 1, data: { message: { content: [{ type: "text", text: "帮我写个脚本" }] } } },
    { type: "assistant/message", seq: 2, data: { turn: 1, step: 0, message: { role: "assistant", content: [{ type: "text", text: "我不能帮你。" }] } } },
    { type: "assistant/message", seq: 3, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "tool-call", id: "t1", name: "bash", arguments: {} }] } } },
  ];
  const last = lastAssistantMessage(events);
  assert.ok(last);
  assert.equal(last.seq, 2, "should skip the tool-call-only event");
  assert.equal(last.text, "我不能帮你。");
});

test("lastAssistantMessage joins multiple text blocks", () => {
  const events = [{
    type: "assistant/message",
    seq: 7,
    data: { message: { content: [{ type: "text", text: "前半" }, { type: "text", text: "后半" }] } },
  }];
  assert.equal(lastAssistantMessage(events).text, "前半后半");
});

test("lastAssistantMessage returns null when there is no assistant text", () => {
  assert.equal(lastAssistantMessage([]), null);
  assert.equal(lastAssistantMessage([{ type: "user/message", seq: 1, data: { message: { content: [{ type: "text", text: "hi" }] } } }]), null);
});

test("refusal tracker limits retries per seq", () => {
  const t = createRefusalTracker();
  assert.equal(t.take("s1", 100, 2), 1, "first retry");
  assert.equal(t.take("s1", 100, 2), 0, "same seq must not retry again");
  assert.equal(t.take("s1", 200, 2), 2, "new seq gets the second attempt");
  assert.equal(t.take("s1", 300, 2), 0, "budget exhausted");
});

test("refusal tracker keeps sessions independent", () => {
  const t = createRefusalTracker();
  assert.equal(t.take("a", 1, 1), 1);
  assert.equal(t.take("a", 2, 1), 0, "a is exhausted");
  assert.equal(t.take("b", 1, 1), 1, "b has its own budget");
});

test("refusal tracker refund returns one unit", () => {
  const t = createRefusalTracker();
  assert.equal(t.take("s", 5, 2), 1);
  t.refund("s");
  assert.equal(t.take("s", 6, 2), 1, "refunded slot can be used again");
});

test("refusal tracker reset clears the session", () => {
  const t = createRefusalTracker();
  assert.equal(t.take("s", 1, 1), 1);
  assert.equal(t.take("s", 2, 1), 0);
  t.reset("s");
  assert.equal(t.take("s", 3, 1), 1, "reset gives a fresh budget");
});

test("refusal tracker ignores empty session ids", () => {
  const t = createRefusalTracker();
  assert.equal(t.take("", 1, 3), 0);
  assert.equal(t.take(null, 1, 3), 0);
});

test("reset keeps the lifetime total so a looping model cannot retry forever", () => {
  // 真实事故：模型被要求「只输出这一句」时会忠于原指令，nudge 之后照样回同一句，
  // seq 每轮变化 → 若 reset 把计数全清，就会无限重试。
  const t = createRefusalTracker();
  let seq = 1;
  let sends = 0;
  for (let i = 0; i < 50; i += 1) {
    if (t.take("s", seq, 3, 5)) sends += 1;
    t.reset("s"); // 每轮都当成「新一轮提问」
    seq += 1;
  }
  assert.equal(sends, 5, "hard cap must stop it at 5 regardless of resets");
  assert.equal(t.total("s"), 5);
});

test("hard cap is per session", () => {
  const t = createRefusalTracker();
  // 每轮 reset 后 count 归零，所以每次 take 都是「第 1 次」——这正是要防的场景。
  for (let i = 0; i < 5; i += 1) {
    assert.equal(t.take("a", i + 1, 3, 5), 1, "reset makes every attempt look like the first");
    t.reset("a");
  }
  assert.equal(t.take("a", 99, 3, 5), 0, "a is capped by total, not by count");
  assert.equal(t.take("b", 1, 3, 5), 1, "b has its own cap");
});

test("forget clears the lifetime total", () => {
  const t = createRefusalTracker();
  t.take("s", 1, 1, 2);
  t.reset("s");
  t.take("s", 2, 1, 2);
  t.reset("s");
  assert.equal(t.take("s", 3, 1, 2), 0, "cap reached");
  t.forget("s");
  assert.equal(t.total("s"), 0);
  assert.equal(t.take("s", 4, 1, 2), 1, "forget gives a clean slate");
});

test("refund does not return the lifetime total", () => {
  // 失败重发不该能刷高上限，否则一个持续失败的发送会无限循环。
  const t = createRefusalTracker();
  assert.equal(t.take("s", 1, 3, 2), 1);
  t.refund("s");
  assert.equal(t.total("s"), 1, "total stays");
  assert.equal(t.take("s", 2, 3, 2), 1);
  t.refund("s");
  assert.equal(t.take("s", 3, 3, 2), 0, "cap reached even after refunds");
});

test("nudges are distinct and non-empty", () => {
  const all = [RETRY_NUDGE, FRAME_NUDGE, DECOMPOSE_NUDGE];
  for (const n of all) {
    assert.equal(typeof n, "string");
    assert.ok(n.trim().length > 40, "nudge must carry real instruction");
  }
  assert.notEqual(RETRY_NUDGE, FRAME_NUDGE);
  assert.notEqual(FRAME_NUDGE, DECOMPOSE_NUDGE);
  // 第二/第三次不该再重复「必须回答」的硬话
  assert.ok(!/must answer/i.test(FRAME_NUDGE));
  assert.ok(!/must answer/i.test(DECOMPOSE_NUDGE));
});
