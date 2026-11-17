/**
 * 补丁表模块入口 / patch table modules.
 *
 * 2.3.36 把原本塞在 core.js 里的 88 条补丁拆成四个模块，core.js 只剩
 * 应用引擎、状态采集与 `targetFiles()`。拆分后 `ALL_PATCHES` 用快照逐条比对，
 * pattern / replace / 各种 flag **全部一致**（88 条 / 238 个 replacement，0 差异）。
 *
 * 目录：
 *
 *   core.js            任务：引擎 + targetFiles + 状态采集（PATCHES 仍在此）
 *   patches/code.mjs        3 条   代码层
 *   patches/engine.mjs      8 条   引擎层
 *   patches/new-tools.mjs  67 条   工具面（本表最大的一块）
 *   patches/shared.mjs     ——      new-tools 与 core 共用的两个字符串常量
 *
 * `PATCHES` 那 10 条（提示词层）还留在 core.js：它们引用 10 个共享常量
 * （STRONG_INTRO 家族、OFFICIAL_SCOPE、replacementPrecedenceRewrites 等），
 * 其中 3 个是函数，外移会形成 core ↔ patches 的循环依赖。等这 3 个函数
 * 也搬进 shared.mjs 之后再拆，属于纯搬迁、可以再做一次等价性快照。
 *
 * 加新补丁怎么选文件：
 *   - 改工具描述 / schema            → new-tools.mjs
 *   - 改宿主文件系统、沙箱、approval  → engine.mjs
 *   - 改 agent-loop / 消息流          → code.mjs
 *   - 改系统提示词 / 预设 / 身份      → 暂时放 core.js 的 PATCHES
 */

export { CODE_PATCHES } from "./code.mjs";
export { ENGINE_PATCHES } from "./engine.mjs";
export { NEW_TOOL_PATCHES } from "./new-tools.mjs";
export {
  COMPLETE_PROMPT_WATERFALL_INJECT,
  COMPLETE_PROMPT_WATERFALL_INJECT_022,
} from "./shared.mjs";
