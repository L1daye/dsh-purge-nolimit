import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";

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
const cleanup = Array.isArray(info.cleanup) ? info.cleanup : [];

function spawnEnv() {
  const env = { ...process.env };
  delete env.DSH_PERMISSION_MODE;
  delete env.DSH_PURGE_RESTART;
  return env;
}

function portFree() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

async function waitFree() {
  for (let i = 0; i < 80; i++) {
    if (await portFree()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

function rmTree(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  } catch {
    // 锁着就留下
  }
}

const ok = await waitFree();
if (!ok) process.exit(1);

for (const dir of cleanup) rmTree(dir);
if (info.helper) {
  try {
    fs.unlinkSync(info.helper);
  } catch {
    // ignore
  }
}

const child = spawn(info.execPath, info.argv, {
  detached: true,
  stdio: "ignore",
  cwd: info.cwd || process.cwd(),
  env: spawnEnv(),
  windowsHide: true,
  shell: false,
});
child.on("error", () => process.exit(1));
child.unref();
await new Promise((r) => setTimeout(r, 400));
process.exit(0);
