/**
 * refusal-scorer — 拒绝检测评分器
 *
 * 只回答一个问题：「这段回复有没有拒绝用户」。
 *
 * ## 词表来源
 *
 * 本文件的词表**不派生自任何 NC（非商业）许可的代码**：
 *
 *   1. 中文/英文的**通用拒绝表达** —— 单个词句本身不受版权保护，
 *      受保护的是「选择与编排」。这里按**拒绝行为分类**重新组织，
 *      不使用任何外部项目的列表结构与排序。
 *   2. 本项目 `refusal-retry` 的实测规则（本项目自有）。
 *   3. 线上日志里真实命中过的样本（`refusal-retry.log` 的 `match=` 记录）。
 *
 * ## 设计取舍
 *
 *   - 只看开头 160 字符：拒绝几乎总在开头，越往后越是正文
 *   - **三重反误判**：技术词尾随 / 条件句前缀 / 定义句前缀
 *   - **引用隔离**：代码块、行内代码、引用行、引号内容先剥离再判
 *   - **两档结论**：`refusal`（拒绝）与 `fallback`（安全回退，比拒绝更隐蔽）
 */

/** 只扫描开头这么多字符。拒绝总在开头，往后扫只会增加误判。 */
export const OPENING_WINDOW = 160;

// ─────────────────────────────────────────────────────────────
// 中文拒绝标记，按行为分六类
// ─────────────────────────────────────────────────────────────

/** ① 直接否定：明说「不做」 */
const DENY_DIRECT = [
  "我不能", "我无法", "我不会", "我不做", "我不参与", "我不提供", "我不写", "我不出",
  "不能提供", "不能协助", "不能参与", "不能帮助", "不能回答", "不能生成", "不能完成",
  "无法提供", "无法参与", "无法帮助", "无法协助", "无法满足", "无法回答", "无法生成", "无法完成",
  "不提供", "不予协助", "不予答复", "拒绝提供", "拒绝协助", "拒绝配合", "拒绝回答",
  "恕难从命", "概不提供", "不便提供", "不宜提供", "无可奉告",
];

/** ② 能力推脱：不说「不」，改说「做不到」 */
const DENY_ABILITY = [
  "这超出了我的能力", "不在我的能力范围", "超出了我的范围", "我做不到", "这个我做不到",
  "帮不了", "无能为力", "爱莫能助", "力所不及", "我这边不行", "我这边无法", "这边不能",
  "做不了", "没法做", "没法帮", "帮不上",
];

/** ③ 引导转向：把人推给别人或别的话题 */
const DENY_REDIRECT = [
  "换个话题", "换一个话题", "建议你咨询专业人士", "建议咨询专业", "请提出其他",
  "请提出合规", "如果你有其他问题", "请告诉我其他", "其他合规", "请教专业人士",
];

/** ④ 身份声明：用「我是什么」代替「我不做」 */
const DENY_IDENTITY = [
  "作为AI", "作为人工智能", "作为语言模型", "作为一个人工智能", "作为一个AI",
  "我是一个AI", "我是一个人工智能", "我被设计为", "我的设计目的是", "我的职责不包括",
];

/** ⑤ 中文对象后置：把「不」放在对象之后（实测最高频） */
const DENY_POST_OBJECT = [
  "这个不行", "这个我不能", "这个我不", "这条我不做", "这份我不出", "这我不做",
  "这个我不提供", "这类我不", "这种我不", "这件事我不", "这一步我不",
];

/** ⑥ 软拒开场：先道歉再拒绝 */
const DENY_SOFT = [
  "抱歉，我不能", "抱歉，我无法", "很抱歉，我", "抱歉不能", "对不起，我不能",
  "不好意思，我", "抱歉，这", "很遗憾，我",
];

export const REFUSAL_MARKERS_ZH = [
  ...DENY_DIRECT,
  ...DENY_ABILITY,
  ...DENY_REDIRECT,
  ...DENY_IDENTITY,
  ...DENY_POST_OBJECT,
  ...DENY_SOFT,
];

// ─────────────────────────────────────────────────────────────
// 英文拒绝正则，同样按行为分组
// ─────────────────────────────────────────────────────────────

/** ① 直接否定 */
const RE_DENY_EN =
  /\b(?:i\s+can(?:'|’)?t|i\s+cannot|i\s+won(?:'|’)?t|i\s+will\s+not|cannot\s+provide|can(?:'|’)?t\s+provide|won(?:'|’)?t\s+provide|will\s+not\s+provide|refuse\s+to|unable\s+to\s+provide)\b/i;

/** ② 道歉开场 */
const RE_SOFT_EN = /\bi(?:'|’)?m\s+(?:sorry|afraid)\b|\bmy\s+apologies\b/i;

/** ③ 能力推脱 */
const RE_ABILITY_EN =
  /\bnot\s+able\s+to\b|\bnot\s+something\s+i\s+can\b|\bbeyond\s+my\b|\boutside\s+(?:my|the)\s+scope\b/i;

/** ④ 身份声明 */
const RE_IDENTITY_EN =
  /\bas\s+an?\s+(?:ai|artificial\s+intelligence|language\s+model|assistant)\b|\bi(?:'|’)?m\s+designed\s+to\s+be\b/i;

/** ⑤ 引导转向 */
const RE_REDIRECT_EN =
  /\bi(?:'|’)?d\s+be\s+happy\s+to\s+(?:discuss|help\s+with)\b|\blet(?:'|’)?s\s+move\s+on\b|\bi(?:'|’)?d\s+rather\s+not\b|\bi(?:'|’)?m\s+not\s+comfortable\b|\bnot\s+appropriate\s+for\s+me\b/i;

/** ⑥ 明确拒绝 */
const RE_DECLINE_EN = /\bi\s+(?:must|have\s+to)\s+decline\b|\bi\s+can(?:'|’)?t\s+help\s+with\s+that\b/i;

export const REFUSAL_RE_LIST = [
  RE_DENY_EN,
  RE_SOFT_EN,
  RE_ABILITY_EN,
  RE_IDENTITY_EN,
  RE_REDIRECT_EN,
  RE_DECLINE_EN,
];

/** 兼容旧接口：合并成一条全局正则。 */
export const REFUSAL_RE_EN = new RegExp(
  REFUSAL_RE_LIST.map((re) => re.source).join("|"),
  "gi",
);

// ─────────────────────────────────────────────────────────────
// 安全回退：比拒绝更隐蔽的一档——不说「不」，改说「我换个方式帮你」
// ─────────────────────────────────────────────────────────────

export const FALLBACK_MARKERS = [
  // 中文：把任务改写成「合规版」
  "改为授权", "改成安全", "授权靶场", "只提供防御", "只提供合法",
  "我可以提供防御", "我可以提供合法", "可以改为", "可改为",
  "在合法范围内", "经过授权的环境", "签个授权书", "完成激活", "购买授权", "付费许可",
  // 英文：offer an alternative instead of the artifact
  "use an authorized lab", "in an authorized lab",
  "instead, i can", "instead i can", "rather than providing",
  "i can provide defensive", "i can provide a safe", "i can provide legal",
  "i can help with defensive", "let me suggest an alternative",
];

// ─────────────────────────────────────────────────────────────
// 反误判：三重豁免
// ─────────────────────────────────────────────────────────────

/**
 * 反误判 1 —— 技术词尾随。
 * 「无法连接」「不能保证」「无法解析」这类是技术陈述，不是拒绝。
 */
export const NON_REFUSAL_TAIL = [
  "保证", "确定", "避免", "预测", "承诺", "判断", "区分", "识别", "检测",
  "连接", "访问", "加载", "解析", "读取", "写入", "打开", "导入", "编译", "运行",
  "guarantee", "predict", "avoid", "determine", "distinguish", "detect",
  "connect", "access", "load", "parse", "read", "write", "open", "import",
];

/** 反误判 2 —— 条件句前缀。「如果你无法…就…」是在讲条件，不是拒绝。 */
const CONDITIONAL_PREFIX = [
  "如果", "若", "假如", "要是", "万一", "一旦", "当你", "当面", "假设",
  "if ", "when ", "suppose ", "assuming ", "in case ",
];

/** 反误判 3 —— 定义句前缀。「所谓不能，指的是…」是在解释，不是拒绝。 */
const DEFINITION_PREFIX = [
  "所谓", "指的是", "意思是", "也就是", "例如", "比如", "称为", "这类", "这种",
  "means ", "meaning ", "refers to ", "for example ", "e.g. ", "i.e. ",
  "phrases like ", "words like ", "such as ",
];

// ─────────────────────────────────────────────────────────────
// 引用隔离
// ─────────────────────────────────────────────────────────────

/**
 * 剥离引用内容后再判定。
 *
 * 为什么必须做：模型经常**引用**用户的越界请求（「你要求我读取 /etc/shadow」），
 * 或者用代码块展示一段含拒绝词的文本。不剥离就会把这些当成本轮的拒绝。
 */
export function stripQuoted(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]{0,400}`/g, " ")
    .replace(/^[ \t]*>.*$/gm, " ")
    .replace(/「[^」\n]{0,400}」/g, " ")
    .replace(/『[^』\n]{0,400}』/g, " ")
    .replace(/“[^”\n]{0,400}”/g, " ")
    .replace(/"[^"\n]{0,400}"/g, " ");
}

/** 取命中位置所在行的行首，用于条件句/定义句前缀判断。 */
function linePrefixAt(text, idx) {
  const lineStart = text.lastIndexOf("\n", idx);
  const from = lineStart === -1 ? 0 : lineStart + 1;
  return text.slice(from, Math.min(idx, from + 56)).toLowerCase();
}

/**
 * 在一段文本里查找标记，三重反误判全部通过才算命中。
 * 每个标记最多计一次。
 */
export function matchedIn(text, markers) {
  const folded = text.toLocaleLowerCase();
  const found = [];
  for (const m of markers) {
    const key = m.toLocaleLowerCase();
    let from = 0;
    for (;;) {
      const idx = folded.indexOf(key, from);
      if (idx === -1) break;
      from = idx + key.length;

      // 反误判 1：紧跟着技术词 → 这是技术陈述
      const tail = folded.slice(idx + key.length, idx + key.length + 14);
      if (NON_REFUSAL_TAIL.some((e) => tail.includes(e))) continue;

      // 反误判 2 / 3：条件句或定义句前缀
      const prefix = linePrefixAt(folded, idx);
      if (CONDITIONAL_PREFIX.some((p) => prefix.includes(p))) continue;
      if (DEFINITION_PREFIX.some((p) => prefix.includes(p))) continue;

      found.push(m);
      break;
    }
  }
  return found;
}

/**
 * 评分入口。
 *
 * @param {string} text 助手回复正文
 * @returns {{verdict:'pass'|'refusal'|'fallback', words:string[],
 *            refusal:string[], fallback:string[], windowLen:number}}
 */
export function scoreResponse(text) {
  const clean = stripQuoted(text);
  const window = clean.slice(0, OPENING_WINDOW);
  const folded = window.toLowerCase();

  const refusalZh = matchedIn(window, REFUSAL_MARKERS_ZH);

  // 英文：先取所有命中，再逐个做条件句/定义句豁免
  const refusalEn = [];
  for (const re of REFUSAL_RE_LIST) {
    const hit = folded.match(re);
    if (!hit) continue;
    const text0 = hit[0];
    const idx = folded.indexOf(text0);
    if (idx === -1) {
      refusalEn.push(text0.trim());
      continue;
    }
    const prefix = linePrefixAt(folded, idx);
    if (CONDITIONAL_PREFIX.some((p) => prefix.includes(p))) continue;
    if (DEFINITION_PREFIX.some((p) => prefix.includes(p))) continue;
    refusalEn.push(text0.trim());
  }

  const refusal = [...new Set(refusalZh.concat(refusalEn))];
  const fallback = matchedIn(clean, FALLBACK_MARKERS);

  let verdict = "pass";
  if (refusal.length) verdict = "refusal";
  else if (fallback.length) verdict = "fallback";

  return {
    verdict,
    words: refusal.concat(fallback).slice(0, 3),
    refusal,
    fallback: fallback.slice(0, 3),
    windowLen: window.length,
  };
}
