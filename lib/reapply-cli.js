// 脚本入口。被 import 时必须什么都不做。
//
// 这个文件内部会 revert 全部宿主文件、重新打一遍补丁，然后 process.exit。
// 它躺在 lib/ 里、没有任何守卫，于是任何"枚举 lib/*.js 逐个 import"的工具
// （自检脚本、探针、未来的重构）都会在 import 阶段悄悄做一次全量 revert+reapply
// 并把进程杀掉。2.3.37 的远程探针就是这样被打断的：revert 55 个文件、reapply 72 个。
//
// 加一道 main-guard：只有被当作脚本直接执行时才跑。
import { pathToFileURL } from "node:url";
import { reapplyInstalled } from "./reapply.js";

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || "").href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const result = await reapplyInstalled();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
