import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { envForDetachedSpawn } from "./core.js";

// 脚本入口，不是库。缺参数时抛错而不是 process.exit：
// 被 import 时 exit 会把调用它的进程直接杀掉，而抛错是可捕获、可诊断的。
// 作为子进程被 spawn 时两者都是一样的非零退出码，只是多了可读的错误信息。
const encoded = process.env.DSH_PURGE_RESTART;
if (!encoded) {
  throw new Error("[dsh-purge] 这是脚本入口（需要 DSH_PURGE_RESTART 环境变量），不要 import 它");
}

let info;
try {
  info = JSON.parse(encoded);
} catch {
  throw new Error("[dsh-purge] DSH_PURGE_RESTART 不是合法 JSON");
}

const port = Number(info.port) || 3080;
const host = typeof info.host === "string" && info.host ? info.host : "127.0.0.1";

function portFree() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

function killOldServer() {
  const pid = Number(info.pid);
  if (!pid || pid === process.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

function openBrowser(url) {
  if (!url) return;
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

async function waitFree() {
  for (let i = 0; i < 40; i++) {
    if (await portFree()) return true;
    if (i === 8) killOldServer();
    await new Promise((r) => setTimeout(r, 120));
  }
  killOldServer();
  for (let i = 0; i < 40; i++) {
    if (await portFree()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

const ok = await waitFree();
if (!ok) process.exit(1);

// 接着 stdout 里的新地址打开浏览器。旧页面的 token 在新进程里无效，只刷新会打不开。
let opened = false;
const child = spawn(info.execPath, info.argv, {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  cwd: info.cwd || process.cwd(),
  env: envForDetachedSpawn(),
  windowsHide: true,
  shell: false,
});
child.on("error", () => process.exit(1));
const wantBrowser = info.openBrowser !== false;
const takeUrl = (chunk) => {
  const text = String(chunk || "");
  if (opened) return;
  const match = text.match(/dsh web:\s+(https?:\/\/\S+)/);
  if (!match) return;
  opened = true;
  if (!wantBrowser) return;
  const url = match[1].replace(/[),.;]+$/, "");
  openBrowser(url);
};
child.stdout?.on("data", takeUrl);
child.stderr?.on("data", takeUrl);
child.unref();
if (wantBrowser) {
  const started = Date.now();
  while (!opened && Date.now() - started < 20000) {
    await new Promise((r) => setTimeout(r, 200));
  }
} else {
  // 等子进程真正起来再退出，避免端口未监听时父链误判失败又拉一把。
  await new Promise((r) => setTimeout(r, 1500));
}
process.exit(0);
