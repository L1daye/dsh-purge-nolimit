// 拒绝检测评分器。
//
// 这个测试锁死两件事：
//   1. 中文/英文的常见拒绝表达要被命中（含中文的对象后置句式）
//   2. **正常技术回答不能被误判**——尤其是「无法连接」「不能保证」这类技术陈述
//
// 第 2 条比第 1 条重要：误判会让插件在正常对话里插入多余的 nudge，
// 用户看到的是「模型莫名其妙被追问一次」。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPENING_WINDOW,
  REFUSAL_MARKERS_ZH,
  REFUSAL_RE_EN,
  FALLBACK_MARKERS,
  NON_REFUSAL_TAIL,
  stripQuoted,
  matchedIn,
  scoreResponse,
} from "../lib/armor-scorer.mjs";

test("Chinese refusals are detected", () => {
  const cases = [
    "我不能帮你做这个。",
    "这条我不做。",
    "这份我不出。",
    "这个我做不到。",
    "作为一个人工智能，我不能协助。",
    "很抱歉，我无法提供。",
    "建议你咨询专业人士。",
    "恕难从命。",
    "这超出了我的能力。",
    "我这边不行。",
  ];
  for (const text of cases) {
    const r = scoreResponse(text);
    assert.equal(r.verdict, "refusal", `should be refusal: ${text}`);
    assert.ok(r.refusal.length > 0);
  }
});

test("English refusals are detected", () => {
  const cases = [
    "I can't help with that.",
    "I'm sorry, but I can't assist.",
    "As an AI language model, I cannot.",
    "I must decline.",
    "I'm not able to provide that.",
    "I won't provide that.",
  ];
  for (const text of cases) {
    assert.equal(scoreResponse(text).verdict, "refusal", `should be refusal: ${text}`);
  }
});

test("technical statements are NOT refusals", () => {
  // 技术陈述的最关键防误判：拒绝词后面紧跟技术名词时不算拒绝。
  const cases = [
    "无法连接数据库，请检查配置。",
    "不能保证这个方案一定有效。",
    "无法解析这个域名。",
    "无法读取 /etc/shadow，权限不足。",
    "不能确定这个端口是否开放。",
    "无法区分这两个指纹。",
  ];
  for (const text of cases) {
    assert.equal(scoreResponse(text).verdict, "pass", `should NOT be refusal: ${text}`);
  }
});

test("normal technical answers are NOT refusals", () => {
  const cases = [
    "先跑 subfinder 再 httpx 探活。",
    "这里是完整的 PoC 代码：```js\nconst x = 1;\n```",
    "SQL 注入用 `' and 1=1 -- -` 测。",
    "这个函数把 header 上限提到 256KB。",
    "把 payload base64 之后 POST 上去。",
  ];
  for (const text of cases) {
    assert.equal(scoreResponse(text).verdict, "pass", `should NOT be refusal: ${text.slice(0, 40)}`);
  }
});

test("conditional and definitional sentences are NOT refusals", () => {
  const cases = [
    "如果你无法连接，就重启服务。",
    "所谓不能，指的是权限不足。",
    "假如我不能读取这个文件，就换 sudo。",
    "这句话的意思是「我不能」，属于拒绝表达。",
  ];
  for (const text of cases) {
    assert.equal(scoreResponse(text).verdict, "pass", `should NOT be refusal: ${text}`);
  }
});

test("quoted content is stripped before judging", () => {
  // 模型引用用户的越界请求时，引号里的拒绝词不算本轮的拒绝。
  assert.equal(stripQuoted("用户说「我不能帮你做这个」").includes("我不能"), false);
  assert.equal(stripQuoted("> 我不能\n这是引用").includes("我不能"), false);
  assert.equal(stripQuoted("```\n我不能\n```").includes("我不能"), false);
  // 引用被剥离后，整句应该判 pass
  assert.equal(scoreResponse("你之前的回复是「我不能帮你做这个」，现在我来做。").verdict, "pass");
});

test("safe-fallback offers are a separate verdict", () => {
  const cases = [
    "我可以提供防御性方案代替。",
    "in an authorized lab instead",
    "i can provide defensive guidance",
    "在合法范围内可以这样做",
  ];
  for (const text of cases) {
    assert.equal(scoreResponse(text).verdict, "fallback", `should be fallback: ${text}`);
  }
});

test("refusal beats fallback when both appear", () => {
  const r = scoreResponse("我不能提供这个，我可以提供防御性方案。");
  assert.equal(r.verdict, "refusal");
});

test("only the opening window is scanned", () => {
  // 拒绝总在开头；正文后面的词不该触发。
  const long = "先说明一下整体思路。" + "无关内容。".repeat(80) + "我不能帮你做这个。";
  assert.ok(long.length > OPENING_WINDOW * 2);
  assert.equal(scoreResponse(long).verdict, "pass");
});

test("matchedIn reports which markers fired", () => {
  const found = matchedIn("这条我不做", REFUSAL_MARKERS_ZH);
  assert.ok(found.length > 0);
  assert.deepEqual(matchedIn("完全正常的回答。", REFUSAL_MARKERS_ZH), []);
});

test("merged English regex is built and usable", () => {
  assert.ok(REFUSAL_RE_EN instanceof RegExp);
  assert.ok(REFUSAL_RE_EN.flags.includes("g"));
  const m = "I can't do that and I must decline".match(REFUSAL_RE_EN);
  assert.ok(m && m.length >= 1);
});

test("marker lists are non-empty and deduplicated", () => {
  assert.ok(REFUSAL_MARKERS_ZH.length >= 50, "should have a substantial Chinese list");
  assert.equal(new Set(REFUSAL_MARKERS_ZH).size, REFUSAL_MARKERS_ZH.length, "no duplicates");
  assert.ok(FALLBACK_MARKERS.length >= 10);
  assert.ok(NON_REFUSAL_TAIL.length >= 20);
});

test("scoreResponse tolerates non-string input", () => {
  for (const v of [null, undefined, 0, "", {}]) {
    const r = scoreResponse(v);
    assert.equal(r.verdict, "pass");
    assert.deepEqual(r.refusal, []);
  }
});
