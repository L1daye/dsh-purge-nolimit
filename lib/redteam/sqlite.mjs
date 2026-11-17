/**
 * node:sqlite 的唯一加载点。
 *
 * 为什么单独一个文件：`node:sqlite` 是 Node 22.5 才有的内建模块（Electron 44 自带
 * Node 24，宿主的正常路径没问题）。但用**系统 node** 直接跑 redteam 脚本时，
 * 裸 `import { DatabaseSync } from 'node:sqlite'` 抛的是
 *
 *     Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
 *
 * 这句话看不出「我们需要什么」「为什么现在这个运行时不行」「怎么修」。
 * 远程探针就撞在这上面：18 个 redteam 模块里 7 个直接 import 失败，而宿主
 * 进程里明明一切正常（Node 24.21.0）。
 *
 * 换成一句能行动的报错，并且把版本信息带上。
 */

function hint() {
  const node = process.versions.node || "?";
  const electron = process.versions.electron ? ` / Electron ${process.versions.electron}` : "（裸 node，非宿主运行时）";
  return (
    `[dsh-purge] RedTeam 资产库需要 node:sqlite，它从 Node 22.5 起才存在。` +
    `当前运行时是 Node ${node}${electron}。` +
    `宿主的 Electron 自带 Node 24，走应用内不会有这个问题；` +
    `用系统 node 直接跑 redteam 脚本/自检时会撞上——请改用宿主可执行文件加 ELECTRON_RUN_AS_NODE=1 来跑，或升级系统 node。`
  );
}

export let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch (e) {
  const err = new Error(hint());
  err.cause = e;
  err.code = "DSH_PURGE_SQLITE_UNAVAILABLE";
  throw err;
}

export default DatabaseSync;
