# kingcharleslzy-ai/dsh-purge（community 1.7.19）vs 你的 2.3.35 — 逆向对比

样本：

- **KC** = `github.com/kingcharleslzy-ai/dsh-purge`，clone 到 `E:\test\_rev\kc-upstream`，HEAD `a3934fd`（2026-11-17 05:53 -0800）
- **NL** = `E:\test\dsh-purge-nolimit`，HEAD `5421bfa`，`2.3.35-dsh022`

---

## 0. 结论先行

两个项目**不是同一条演进线的两个版本**，是**同一个插件内核的两个不同侧重方向**：

| | KC community 1.7.19 | NL nolimit 2.3.35 |
|---|---|---|
| 定位 | **工程化 / 可运维**：25 层自检、半自动重锚、快照回滚、完整更新系统、市场分发 | **破甲强度 / 可观测**：88 条补丁、注入验甲、飞行记录仪、拒绝检测器、rc.3 锚点齐全 |
| 补丁数 | 85 声明 + #90 生成 = 86 | 88 |
| lib 文件 | **121**（顶层 92） | 69（顶层 51） |
| 测试文件 | **114**（696.7 KB） | 21 |
| docs | **150**（含 `docs/releases/` 80 份） | 13 |
| 许可 | MIT | Apache-2.0 |
| 宿主声明 | `>=0.2.1-rc.1 <0.3.0`，`dshReleases` 逐版本标 compatible/unknown | `dshTarget: 0.2.2-rc.3` |
| **Windows rc.3** | **官方 AGENTS.md 明写「Windows rc.3 未复测补丁」** | **我实测 71/71、70 applied、零漂移** |

**最重要的一条**：补丁覆盖两边基本等价（85 条 ID 与名字**逐条相同**），差距全在**外围工程**。而 KC 自己在 AGENTS.md §9 写了「Windows rc.3 未复测补丁」——**你这边反而在 Windows rc.3 上有实测证据**。

---

## 1. 补丁表对比

### 1.1 ID 集合

用统一正则（兼容 `id:` 与 `"id":`）扫描：

```
KC         85 条（ID 1..94，另有 #90 由 steering.js 生成 → 合计 86）
NL         88 条（ID 1..95）
交集       85 条，名字逐条完全相同，零改名
只在 NL    #85 #86 #95
只在 KC    无
```

### 1.2 那 3 条「只在 NL」的其实不是差集

| ID | NL 名字 | KC 侧对应 |
|---|---|---|
| 85 | `SESSION_PROMPT_ALWAYS_FOLLOWUP` | **已被 KC #90 取代并移出补丁表** |
| 86 | `SESSION_QUEUE_STEER_INTERRUPT` | 同上 |
| 95 | `INSPECTOR_FRAME_BUDGET_RECORD_OVERHEAD` | KC 在 `stability.mjs` 里用 `id === 95 ? ... : ...` 模板生成，正则没抓到名字 |

KC `lib/patches/index.mjs:18` 原文：

```js
// #85/#86 已被 #90（RESTORE_NATIVE_STEERING）取代并移出 ALL_PATCHES，
```

### 1.3 steering：两种做法，同一意图

**NL 的做法**：保留 #85/#86 编号，但已改成「恢复原生」语义。

```js
// lib/core.js #85
replace:
  '\t\t\t\t\tif (request.mode === "steer") agent.steer(message); // [dsh-purge-85] steer stays interrupt\n' +
  '\t\t\t\t\telse agent.followup(message);',
forbid: ["[dsh-purge-85] user prompt always next-turn"],
```

**KC 的做法**：废弃 #85/#86，新建 #90 `RESTORE_NATIVE_STEERING`，把它做成一条**迁移补丁**——认领 6 种历史形态，全部改回上游：

```js
export const STEERING_RESTORE_PATCH = {
  id: 90,
  name: "RESTORE_NATIVE_STEERING",
  file: ["api-session-controller", "agent-loop"],
  strictFiles: true,          // 插话是用户直接感知的行为，锚点失配必须报出来
  requireAllTargets: true,
  forbid: ["[dsh-purge-85]", "[dsh-purge-86]", "[dsh-purge] steer degrades to followup"],
  replacements: [
    { pattern: OLD_QUEUE_FALLBACK,       replace: NATIVE_QUEUE_GUARD },
    { pattern: OLD_PROMPT,               replace: NATIVE_PROMPT },
    { pattern: OLD_QUEUE_CASE,           replace: NATIVE_QUEUE_CASE },
    { pattern: OLD_QUEUE_CASE_GATED,     replace: HOST_QUEUE_CASE_GATED },
    { pattern: OLD_STEER,                replace: NATIVE_STEER },
    { pattern: UPSTREAM_RECOVERED_STEER, replace: NATIVE_STEER },
  ],
};
```

**KC 多出来的两样东西值得抄**：

**① `gated` 形态**——0.2.2-rc.1 起 dsh-go（手机本机引擎）在 `case "steer"` 前插了一行生命周期闸门：

```js
'\t\t\tcase "steer":\n' +
'\t\t\t\tthis.ctx.get("sessionPersistence")?.dshGoDeletion?.assertAdmit(agent.id);\n' +
'\t\t\t\tagent.inbox.remove(request.itemId);\n' +
'\t\t\t\tagent.steer(message);'
```

本机 rc.1 / rc.3 桌面版**没有**这一行（我查了：`assertAdmit=false`），所以对你的现状不影响，但换成 dsh-go 就会漏。

**② 语义验证函数**而不是 marker：

```js
export function nativeSteeringRestored(text) {
  const source = String(text).replace(/\r\n/g, "\n");
  if (STEERING_RESTORE_PATCH.forbid.some((m) => source.includes(m))) return false;
  const controller = source.includes("async updateQueue(");
  const loop = source.includes("\tsteer(input) {");
  if (!controller && !loop) return false;
  return (
    (!controller ||
      ([NATIVE_QUEUE_GUARD, NATIVE_PROMPT].every((p) => source.includes(p)) &&
        [NATIVE_QUEUE_CASE, HOST_QUEUE_CASE_GATED].some((p) => source.includes(p)))) &&
    (!loop || source.includes(NATIVE_STEER))
  );
}
```

注释写的正是你 AGENTS.md 陷阱 13 的结论：

> A marker on one branch cannot certify a whole controller. Unknown or partial rewrites stay unmodified and are reported by strictFiles, not silently settled.

**这一条几乎可以逐字搬进你的仓库**——它把「marker 不能证明整个文件」变成了一个可执行的判定函数。

---

## 2. 模块级差异

### 2.1 KC 独有的 56 个 lib 模块，按用途归类

**更新系统（12 个，约 90 KB）** —— 你完全没有对等物：

```
update-policy.js (13.0KB)   偏好与调度器，永不 apply 补丁、永不重启
update-http.js (12.0KB)     HTTP 拉取
update-install.js (13.2KB)  安装编排
update-net.js (9.6KB)       网络层
update-secrets.js (7.0KB)   凭据单独落盘（与行为偏好分离）
update-state.js (7.3KB)     状态机
update-integrity.js (2.9KB) 完整性校验
update-socks.js (2.8KB)     SOCKS 代理
update-system-proxy.js (2.6KB) 系统代理探测
update-mirror.js (1.3KB)    镜像源
update-download.js (1.3KB)  下载
update-targets.js (1.1KB)   多 profile 目标解析
```

设计要点（`update-policy.js` 首行注释）：

> Independent update preferences and scheduler. **Never applies host patches or restarts.**

以及 `update-secrets.js` 的分离理由：

> 更新通道的代理与密钥单独落盘：它们属于网络凭据，与「自动检查/安装」这类行为偏好分开，便于用户单独备份或排除。

**desktop handoff（7 个，约 43 KB）** —— 正是我这次踩坑那块的工业级实现：

```
windows-asar-handoff.js (15.6KB)   PowerShell 助手：等 Electron 完全退出再改名
macos-asar-handoff.js   (9.3KB)
desktop-cli.js          (4.2KB)
desktop-entry.js        (2.6KB)
desktop-identity.js     (8.6KB)
desktop-handoff.js      (0.7KB)
desktop-read-scope.js   (1.5KB)
```

**preset 体系（6 个，约 30 KB）**：

```
preset-compat.js     (14.6KB)
preset-injection.js  (3.8KB)
presets-plugin.js    (3.7KB)
presets.js           (3.1KB)
preset-diagnostic.js (2.3KB)
preset-presence.js   (2.2KB)
```

**安装 / 回滚 / 维护（8 个）**：

```
rollback-transaction.js (5.3KB)  事务式回滚
install-registry.js     (3.7KB)  公共镜像缺版本的窄恢复
installed-package.js    (2.1KB)
maintenance-lock.js     (8.8KB)  维护锁（含 stale 检测）
atomic-files.js         (4.0KB)
remove-tree.js          (3.0KB)
restore-backup.js       (1.2KB)
path-boundary.js        (2.4KB)
```

**布局 / 实例解析（4 个）**：

```
host-layout.js     (7.8KB)
runtime-layout.js  (6.0KB)
instance.js       (20.4KB)
next-host.js       (2.6KB)
```

**自检 / 诊断（2 个）**：

```
selfcheck.js (16.1KB)  25 层语义自检
anchors.js    (3.0KB)  本地重锚覆盖
```

**其它**：`community.js`(42.6KB)、`boost.js`(2.7KB)、`steering.js`(4.5KB)、`tuning.js`(5.1KB)、`apply-gate.js`(1.2KB)、`command-registration.js`(1.0KB)、`stream-observation.js`(1.2KB)、`tar-import.js`(6.2KB)、`yaml-runtime.mjs`、`official-installer.*`

### 2.2 NL 独有的 14 个模块

```
armor-scorer.mjs       (11.9KB)  拒绝检测器（58 中文标记 + 22 英文正则）
verify.js              (13.4KB)  飞行记录仪：最近 N 轮注入是否真到
trace.js               (9.1KB)   破甲时间线：按轮聚合探针日志
preflight.js           (6.9KB)   只读补丁预检
prompt-snapshots.js    (6.4KB)   提示词快照 save/use/list
session-tools.js       (7.2KB)   会话导出/统计
profile-insert.js      (13.6KB)  profile 自愈插入
preset-default.js      (5.9KB)   默认预设声明
apply-progress.js      (1.2KB)
mnemon-settings.js     (1.6KB)
native-tool-compat.js  (8.9KB)   DSML 正文工具调用守卫
default-prompt-inject.{md,zh,en}.md ×3 (34.7KB each)
```

**这 14 个 KC 一个都没有。** 也就是说：

- KC 有 `selfcheck`（磁盘证据），NL 有 `verify`/`trace`（运行期证据）——**互补，不是重复**
- KC 有 25 层语义分组，NL 有 88 条逐条状态 + 飞行记录仪
- KC 没有拒绝检测器（`armor-scorer`）、没有提示词快照、没有 DSML 守卫

### 2.3 共有文件的大小差

| 文件 | KC | NL | 说明 |
|---|---|---|---|
| `core.js` | 189 KB | 391 KB | NL 把整张补丁表放在 core.js；KC 拆到 `lib/patches/`（180 KB） |
| `net-scope.js` | 16.3 KB | 29.3 KB | NL 有完整门禁逻辑（但恒放行）+ 更多判定函数 |
| `probe.js` | 2.5 KB | 9.3 KB | NL 版更完整（含 zstd 会话读取、128MB 上限、从后往前扫） |
| `update.js` | 54.5 KB | 39.2 KB | KC 拆出 12 个模块后主文件反而更大 |
| `extract-asar.js` | 23.9 KB | 16.1 KB | KC 多了 handoff 相关探针 |
| `refusal-retry.js` | 11.0 KB | 16.3 KB | NL 加了 `knownAgents` 登记表 + 累计上限 |
| `audit.js` | 6.6 KB | 8.7 KB | NL 版多 3 项检查（加密槽、hooks 旁路等） |
| `asset-table.js` | 16.9 KB | 25.1 KB | 槽体量不同（NL 20172 字符） |

**注意 `core.js` 的结构差异**：KC 把补丁表拆成 7 个模块

```
code.mjs        3 条
engine.mjs     12 条
new-tools.mjs  58 条   (134 KB)
opt-in.mjs      2 条
prompt.mjs     10 条
shared.mjs / stability.mjs / index.mjs   常量与汇总
```

NL 全部塞在 `core.js` 里，391 KB 单文件。**KC 的拆分明显更好维护**——改一条补丁不用在 400KB 文件里定位。

---

## 3. KC 的 25 层自检（`selfcheck.js`）

`BYPASS_LAYERS` 把 86 条补丁按**语义目标**分成 22 组，每组带一句「拆掉了什么」。这是你的 88 条逐条状态做不到的——**逐条告诉你"这行改了"，分层告诉你"用户的哪个痛点被解决了"**：

```js
export const BYPASS_LAYERS = Object.freeze([
  { ids: [15],                 title: "沙箱 confine 直通",   kind: "host",
    why: "read-only / workspace-write 也不再把命令包进 bwrap 等 runner，denial 签名为空" },
  { ids: [16],                 title: "文件系统围栏禁用",     kind: "host",
    why: "写/改文件不再因只读或工作区边界被 FS_SANDBOX_DENIED 拦掉" },
  { ids: [17],                 title: "观察策略放行",         kind: "host",
    why: "edit 不再要求先 read，版本冲突门也放行" },
  { ids: [6, 33, 48],          title: "拒绝话术中性化",       kind: "host",
    why: "工具描述里不再教模型'沙箱会拒绝，请申请审批'" },
  { ids: [7, 8, 10],           title: "默认策略",             kind: "host",
    why: "沙箱默认 danger-full-access、审批默认 never（可被 UI 覆盖，不写死 env）" },
  { ids: [9, 35],              title: "审批自动放行",         kind: "host",
    why: "审批门直接授信；rejected/cancelled/unavailable 也不再抛错打断回合" },
  { ids: [59],                 title: "Auto Review 不拦工具", kind: "host" },
  { ids: [60, 62, 61],         title: "工具审批 fail-open",   kind: "host",
    why: "run_code / 无审批通道时放行；用户主动点拒绝仍然拒绝" },
  { ids: [63],                 title: "计划模式不硬拦",       kind: "host" },
  { ids: [4, 25, 43, 71, 76],  title: "官方身份剥离",  optionalIds: [71, 76] },
  { ids: [32, 53],             title: "Web 面身份中性化" },
  { ids: [40, 74, 55, 72],     title: "注入不被预设覆盖",
    why: "complete 预设、首轮 assemble、每步 system 替换都保留 dsh-purge 注入" },
  { ids: [26, 28],             title: "极简/梁神预设保留注入", optionalIds: [28] },
  { ids: [29, 50],             title: "外部内容不降级为只读" },
  { ids: [30, 31, 64, 65],     title: "Hooks 不否决回合",     optionalIds: [30, 31, 64, 65] },
  { ids: [21, 22, 23],         title: "工具上限放宽" },
  { ids: [24, 37],             title: "预设与子代理不设锁" },
  { ids: [51, 52],             title: "新会话与日志默认" },
  { ids: [56, 58, 75, 77],     title: "回退不残留" },
  { ids: [47, 49, 57, 69],     title: "模型网关兼容" },
  { ids: [87, 88, 90],         title: "会话消息投递与挂载" },
  { ids: [82, 83, 84],         title: "桌面宿主启动兜底",     optionalIds: [82, 83, 84] },
]);
```

状态词汇比你的细：

```
ok       已确认
pending  待应用（不是故障）
inferred 宿主推导（黄）
unknown  证据不足（黄）
broken   已确认故障或权限不匹配
```

**注意 `optionalIds` 的设计**：一条语义层里混着必需补丁和可选补丁时，可选的那几条不参与「这层是否达标」的判定。你的 `optional: true` 只影响分母，不影响语义分组。

### 3.1 但 KC 的 selfcheck 有个明确的自我限制

`selfcheck.js:195`：

```js
return { ...base,
  why: "仅检查目标磁盘的 app.asar，不证明当前进程加载来源；运行入口证据见 host-status",
  ok: !sealed, state: sealed ? "broken" : "ok", ... };
```

**KC 也承认 selfcheck 只看磁盘。** 它把「进程到底加载了哪一份」甩给 `host-status`。这正是我这次踩的坑——我给你的 `selfcheck.mjs` 现在也只查磁盘，只是把 asar 存在直接判成 FAIL。

**比你强的地方**：KC 明确区分「磁盘已就绪」和「进程已加载」，不把两者混成一个绿灯。
**比你弱的地方**：`host-status` 也只读磁盘布局与「当前服务入口证据」，不是真正证明。

---

## 4. 你比 KC 强的地方

### 4.1 Windows rc.3 有实测，KC 没有

KC `AGENTS.md` §9 原文：

```
| 0.2.2-rc.3 | 官方 rc.3 隔离副本 86 条补丁 74 applied / 零漂移，二次应用幂等；
              真实 Host Loader 预设注册通过。**Windows rc.3 未复测补丁。** |
```

你这边（LAPTOP-TCS0Q7P4，Windows，rc.3 真实安装）：

```
patchStatus  tally = {applied:70, na:15, skipped:3}
applyPatches 第一轮 61 写入 / 第二轮 0 写入（幂等）
live.status  patches=71/71 pending=0 na=4 lost=false
live.audit   11/11 full_break=true
```

**这是真实 Windows rc.3 端到端证据，KC 没有。** 而且我这次顺手补的 `#18` rc.3 锚点（`post-execute` 去掉 `block` 分支的形态）KC 也没做——KC 的 `opt-in.mjs` 用 `[legacyBlock, []].map(...)` 生成了两个形态，但那是**给 #18 生成 pattern**，不是给 rc.3 的新形态。你这边已经验证 `post-execute` 钩子与 `observe()` 都已从宿主源码消失。

### 4.2 运行期可观测链

KC 的 selfcheck 是「磁盘证据 + 推导」。你的 `verify.js` 是**读飞行记录仪**：

```
[assemble.rewrite] enabled=true mode=full fullBytes=20171 injectBytes=20171
                   anchorApplied=true injectHead=true chatml=true afterCloser=0
```

KC 没有对等物。它的 `probe` 要模型回显 nonce，而你 AGENTS.md 陷阱 19 已经论证过「模型回显不能当判据」——你的 `trace.js` + `verify.js` 直接读装配日志，比 nonce 回显硬。

### 4.3 拒绝检测器

`armor-scorer.mjs`（11.9 KB，58 中文标记 + 22 英文正则）+ 面板 `ArmorBadge` 实时标拒绝。KC 有 `refusal-retry.js` 和 `refusal-corpus` 测试，但没有等价的面板级实时评分。

### 4.4 DSML 正文工具调用守卫

`native-tool-compat.js`（8.9 KB）。KC 完全没有。这是你独有的——`deepseek-v4.1-flash` 系在某些供给方上把工具调用写成正文时，KC 那套会直接挂住。

### 4.5 提示词槽与快照

你有 20172 字符的加密槽 + `prompt-snapshots.js` 的 save/use/list。KC 有 `scripts/embed-default-prompt.mjs` 但没快照机制，也没 `lib/default-prompt-inject.md`（它 `files` 里没有明文 md，走别的通道）。

---

## 5. 值得移植的（按价值排序）

### P0 — 直接解决你已知问题

**① `windows-asar-handoff.js`（15.6 KB）**

这次手工解包踩的坑，KC 有工业级实现。它的 PowerShell 助手做了这些你手工没做的事：

```powershell
# 1. 独立锁文件，避免并发重入
$lock = $AsarPath + '.rename-pending'
# 2. 唯一备份名，永不覆盖
$backup = $AsarPath + '.purge-' + $Token + '.bak'
# 3. 不依赖 Get-FileHash（PS7 父进程可能污染 5.1 的 PSModulePath）
function Archive-Hash([string]$file) { ...[Security.Cryptography.SHA256]::Create()... }
# 4. 状态文件原子替换，不覆盖别人的 state
[IO.File]::Replace($tmp, $StatePath, ...)
# 5. 轮询等 Electron 完全退出，绝不按定时器 kill 宿主
while ((Get-Date) -lt $deadline) { $alive = Get-Process -Name $processName | Where Path -eq $ExePath ... }
# 6. 改名前后双哈希校验
if ((Archive-Hash $AsarPath) -ne $expectedHash) { throw 'Archive changed while waiting' }
if ((Archive-Hash $backup) -ne $expectedHash) { throw 'Backup hash verification failed' }
# 7. 区分「共享冲突」与「拒绝访问」——只有前者值得继续等
if ($failure.win32_code -notin @(32,33)) { Save-State 'failed' ...; exit 1 }
```

还有一条关键前置校验：

```powershell
if (-not (Test-Path (Join-Path $appDir 'package.json'))) {
  throw 'Unpacked app/package.json is missing; original archive retained.'
}
```

**这正是我缺的那道闸**——如果解包不完整就绝不改名，避免把宿主弄成两边都不完整的状态。

**② `anchors.js`（3.0 KB）+ `diagnose`/`reanchor` 子命令**

本地重锚覆盖，不改插件源码：

```
$DSH_HOME/dsh-purge/anchor-overrides.json
{ "24": { "0": { "pattern": "...", "at": "...", "host": "0.2.1-rc.2" } } }
```

`diagnose` 给出文件、行号、旧锚点首行与**可能的新落点**；`reanchor apply <id> --lines A-B` 落地；`reanchor clear <id>` 撤销。

**对你的价值**：你每次适配新宿主都要改 `core.js` 再发版。有了这个，用户自己就能重锚，你只收 issue。

**③ `strictFiles` + `requireAllTargets` + 语义验证函数**

KC #90 的做法：

```js
strictFiles: true,       // 锚点失配必须报出来，不能被 soft-ok 吞掉
requireAllTargets: true, // 所有目标文件都要达标
```

你的 `#62` 就是被 `markersAny` 的软判定坑过的（4 个 deny 分支残留却报 applied）。#90 这套是**同一个教训的正式解法**：

```js
// A marker on one branch cannot certify a whole controller.
export function nativeSteeringRestored(text) { ... }
```

建议：给风险高的补丁（#62、#16、#15、#35）都配一个语义验证函数，状态判定从「marker 在不在」升级成「整个文件达不达标」。

### P1 — 补齐运维能力

**④ 更新系统（12 模块）**

KC 的设计原则值得照抄：

```js
/** Independent update preferences and scheduler. Never applies host patches or restarts. */
```

- 行为偏好（`update-preferences.json`）与网络凭据（`update-channel.json`）**分文件**
- `dshReleases` 逐版本标 `compatible`/`unknown`，**不把未测版本写成 compatible**
- 多 profile 更新时以每个 profile 的实际包版本为准，不把 `applied: true` 当全部成功

你现在只有 `update.js`（39 KB）。要不要引入 12 个模块看你需求；但「凭据与偏好分离」「逐版本诚实标注」这两条是**低成本高价值**的。

**⑤ 快照/回滚（`rollback-transaction.js` + `install-registry.js`）**

你现在是 `.bak` 文件级回退。KC 是事务：

```
$DSH_HOME/dsh-purge-community/backups/<id>/
  manifest.json     小文件正文 + 大文件清单
  objects/          大文件内容寻址
```

`rollback <id>` 可回到任一快照。对「用户装完插件把宿主弄坏了」这种场景，差别很大。

**⑥ 25 层语义分组**

把你的 88 条按 KC 的 `BYPASS_LAYERS` 分组（双方 ID 一致，可以直接搬），面板就能从「74/74」变成「22 层里哪层没达标 + 为什么」。这是**用户体验层面最大的一次提升**，成本只是加一个常量数组 + 渲染。

### P2 — 工程化

**⑦ 补丁表拆分**

`core.js` 391 KB 拆成 `lib/patches/{code,engine,new-tools,opt-in,prompt,shared,stability}.mjs`。改一条补丁不用在 400KB 里定位。

**⑧ 测试规模**

KC 114 个测试文件 / 696.7 KB。你 21 个。KC 的测试按主题覆盖到：`update-*`（9 个）、`maintenance-*`（4 个）、`steering-*`（3 个）、`desktop-*`（5 个）、`redteam-*`（5 个）、`refusal-*`（3 个）。**建议优先补**：`steering`、`update-policy`、`selfcheck`、`anchors`。

**⑨ 文档结构**

KC 是 `docs/{troubleshooting,compatibility,maintenance-archive,INSTALLATION,MARKET-MIGRATION,DSH-STORE}.md` + `docs/releases/<version>.md`（80 份单版说明，单版限 8 KiB）。你的 `release-notes.md` 已经 130+ KB 单文件了。

---

## 6. 不建议移植的

| 项 | 理由 |
|---|---|
| `opt-in.mjs` 的 #18/#19 `disabledByDefault: true` | KC 把重复调用守卫和结果修剪补丁默认关掉（理由是"开启会取消上下文保护"）。你这边是默认开——**这是产品取向差异，不是 bug**。你要的是全开。 |
| `community.js`(42.6 KB) / `market/` / `packages/purge-panel` | 市场分发与本机面板，绑定 KC 自己的 `index.json` 生态 |
| `dshTarget: "0.2.1-rc.1..."` 字段写法 | 你已改成 `0.2.2-rc.3`，更准确。KC 的 `dshTarget` 字段其实和 `dsh.compatibility.dshReleases` 重复，两套声明容易打架 |
| 25 层里 `optionalIds` 的补丁 ID | 直接搬 KC 的数组即可，但注意你的 ID 比你多 3 个（85/86/95），分组时要补进去 |

---

## 7. 一个值得警惕的差异

KC `AGENTS.md` §10 的硬性约束里有两条你需要对照：

```
1. 不自动重启 DSH。
2. 不自动点「应用」。
```

你的 `cordis.patch.yml` 是：

```yaml
autoApplyOnStart: true
```

而 KC 的 `update-policy.js` 首行就写 `Never applies host patches or restarts`。

**这两者取向相反**：KC 要求用户显式点「应用」，你装完自动应用。你的取向对"一次配好就别烦我"更友好，但代价是——**宿主官方更新后 asar 会重新出现，你的自动应用会在用户不知情的情况下把补丁写到 `app/`（而进程加载的是新 asar）**，正好造成这次那个「看起来全绿但没生效」的状态。

KC 用「不自动应用 + 明确区分 pending 状态」规避了这个。你现在的 `selfcheck` 已经能抓到，但**根因在 `autoApplyOnStart: true`**。

建议：至少让 `autoApplyOnStart` 在检测到 asar 重新出现时**降级为 pending 并提示**，而不是直接写盘。

---

## 8. 一句话总结

**KC 赢在工程化，你赢在破甲强度与 Windows rc.3 实测。**

补丁覆盖两边等价（85 条 ID 名字逐条相同），真正该抄的是三件东西：

1. **`windows-asar-handoff.js`** —— 把这次手工踩的坑变成有哈希校验、状态机、超时、锁的正式实现
2. **`anchors.js` + `reanchor`** —— 让用户自己重锚，你不用每次发版
3. **`strictFiles` + 语义验证函数** —— `#62` 那类「marker 命中但分支残留」的正式解法

以及一个产品级建议：**25 层语义分组**，把你 88 条的逐条绿灯变成「22 层里哪层没达标」。
