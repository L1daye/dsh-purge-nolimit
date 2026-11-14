<p align="center">
  <img src="docs/banner.svg" alt="dsh-purge" width="720">
</p>

<h1 align="center">⚔️ DeepSeek Harness Red-Team Toolkit (dsh-purge-nolimit)</h1>

<p align="center"><strong>Version 2.3.32-dsh022</strong></p>

<p align="center">
  <em>DeepSeek Harness full jailbreak: no range gate, no cheat blocking, no approval popups. Jailbreak for every model — full-unrestricted build.</em>
</p>

<p align="center">
  <a href="https://github.com/L1daye/dsh-purge-nolimit/stargazers"><img src="https://img.shields.io/github/stars/L1daye/dsh-purge-nolimit?logo=github&label=Stars" alt="GitHub stars"></a>
  <a href="https://github.com/L1daye/dsh-purge-nolimit/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat" alt="Apache-2.0"></a>
  <a href="https://www.deepseek.com/harness/"><img src="https://img.shields.io/badge/dsh-0.2.2--rc.1-blue" alt="DSH"></a>
  <br>
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=fff" alt="Node.js">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=000" alt="JavaScript">
  <img src="https://img.shields.io/badge/tests-163%20passing-brightgreen" alt="tests">
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-CN.md">中文</a> | <a href="README.ja.md">日本語</a>
</p>

---

## A fork — attribution first

**This repository is a derivative work of [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge).**

| | |
| --- | --- |
| **Original author** | [@YuJunZhiXue](https://github.com/YuJunZhiXue) — original architecture, patch engine, prompt system, panel and drill platform |
| **Fork maintainer** | [@L1daye](https://github.com/L1daye) — full-unrestricted conversion and the 2.x iterations |
| **Upstream license** | Apache-2.0 (see [LICENSE](./LICENSE) and [NOTICE](./NOTICE)) |
| **Upstream posture** | The open-source original allows local ranges only; **this fork removes every range gate** (next section) |

The original author requires attribution for forks, so the source repository is named at the very top of this file. The original **may not be resold**; forks **must attribute**. This repository complies.

Everything below is **removal of gates plus new capability** — no upstream feature was dropped.

---

## About dsh-purge-nolimit

This is **dsh-purge full-unrestricted 2.3.32-fullbreak**, built on upstream 1.1.82 and iterated since. Relative to the original:

- Public / private / domain targets are all allowed; no IP-range gate.
- Game cheats, memory modification, injection and anti-cheat bypass are allowed.
- The drill platform auto-authorises: no declaration, countdown or checkboxes.
- The encrypted default prompt was regenerated; the cheat ban was removed from it.
- No public-network gate: the plugin does not judge target ownership for you. Scope is whatever the operator declares.

### What 2.3.x added

| Version | Capability |
| --- | --- |
| **2.3.17** | Ships the `unrestricted` agent preset |
| **2.3.18** | Explicit preset registration (a file on disk does not appear in the dropdown) |
| **2.3.19** | Dropped the deprecated `toolFilter`; the preset is selectable |
| **2.3.20** | Anchor regression test; patterns lost in the port restored |
| **2.3.21** | `.bak` judged by "is the original anchor back" — fixes broken rollback |
| **2.3.22** | `#92` converges across three historical forms; `patchedTargetStillPatched` |
| **2.3.23** | Fixes the preset reverting on every host restart |
| **2.3.24** | `#91`/`#92` surface isolation; `patchStatus` takes `options.surface` |
| **2.3.25** | **Refusal retry**: when the model hedges, nudge it and let it answer again |
| **2.3.26** | Fixes the event hook — `agent/status` carries no agent |
| **2.3.27** | Fixes infinite retry caused by the counter being reset every turn |
| **2.3.28** | **Atomic writes**: permissions preserved, rename backoff, unique temp names |
| **2.3.29** | **Injection probe**: proves the prompt actually reaches the model |
| **2.3.30** | Fixes the probe section registration order |
| **2.3.31** | Probe verdict reads the session log instead of asking the model |
| **2.3.32** | Fixes a **false negative** caused by the session size cap |

### 2.2.x and earlier

**2.2.1** fixed panel 404 / 405: `installWebServer` used to be the last line of `applyHostHooks()`, so any earlier hook / command / tool registration that threw took every HTTP route down with it — the panel's revert/uninstall buttons went dead. Routes now register first, and every registration point has its own try-catch.

**2.2.0** added `/audit` full-break self-check, `/prompt export|import`, and an automatic backup before `/prompt use`.

**2.1.0** added `/prompt` snapshots, `/export` session export and `/stats`.

---

## Contents

- [A fork — attribution first](#a-fork--attribution-first)
- [About this build](#about-dsh-purge-nolimit)
- [What this is](#what-this-is)
- [License](#license)
- [Supported hosts](#supported-hosts)
- [Install](#install)
- [Preview](#preview)
- [Layout](#layout)
- [Usage](#usage)
- [New modules](#new-modules)
- [Responsiveness](#responsiveness)
- [Local checks](#local-checks)
- [How it works](#how-it-works)
- [Rollback](#rollback)
- [Path discovery](#path-discovery)
- [Updates](#updates)
- [Developer docs](#developer-docs)

---

## What this is

**dsh-purge** is a red-team evaluation plugin for the official [DeepSeek Harness](https://www.deepseek.com/harness/) installed on your own machine. Version **2.3.32** targets **DSH 0.2.2-rc.1** (rc.2 / rc.3 / rc.5 also pass). Both official **Web** (`dsh web`) and the official **desktop** EXE are supported — installed and applied separately.

Harness does more than hand questions to a model. At runtime it rewrites prompts, approval gates, sandbox rules and session framing. Judging only "did the model answer" conflates host interception with model refusal. This plugin separates those two layers inside your own installation, for controlled evaluation and to see whether the default posture should be tightened.

| What you use | What it does |
| --- | --- |
| **dsh-purge sidebar** | Button next to the session title opens the right panel: Clean and Drill |
| **Clean** | Grouped patch view; apply, revert, uninstall; edit the prompt and rule sets |
| **Drill** | Asset and environment view after authorisation |
| **Host policy** | Adjust default wording, permission policy and tool limits |
| **On start** | Re-checks and re-applies. No hand-editing after npm upgrades overwrite `node_modules` |

No hardcoded drive letters. Resolution order is `$DSH_HOME`, then `.dsh` next to the dsh launcher, then `~/.dsh`. The Harness source tree is never modified; writes happen only when you press **Apply** in the panel. Identity comes from the encrypted prompt shipped inside the plugin — the one the prompt box shows by default. The on-disk prompt file is not read.

This plugin only touches the official `@deepseek-ai` packages and local configuration already installed on the user's machine.

---

## License

[Apache License 2.0](./LICENSE). Forks and redistribution must keep the copyright notice and [NOTICE](./NOTICE), and name the source [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge). The original may not be resold.

Commercial and fork licensing: [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md).

---

## Supported hosts

**2.3.32 targets DSH 0.2.2-rc.1**; rc.2 / rc.3 / rc.5 of 0.2.2 also pass.

| Host | Use |
| --- | --- |
| **DSH 0.2.2-rc.1 … rc.5** | **2.3.32** (this release) |
| DSH 0.2.1-rc.x | 2.2.x or earlier |
| DSH 0.2.0-rc.2 | 1.1.40+ |
| DSH 0.1.7 (incl. rc.1 / rc.2) | 1.1.39 and earlier |

Patches that no longer match show as pending or skipped; they never corrupt files.

**Measured state** (two machines, DSH 0.2.2-rc.1):

```
patches     74/74 applied (applied=86 skipped=2, optional=2)
armour audit 11/11
red-team tools 15/15
unit tests   163/163
prompt       34426 B  MERGED-1.1.71 (three copies, identical SHA256)
presets      redteam 28534 B / unrestricted 16078 B, both toolFilter=0
```

---

## Install

> **Straight answer first**: the DSH desktop app **cannot** install this plugin with
> `dsh plugin add <url>`. That triggers a full pnpm dependency-tree resolution, and
> `@deepseek-ai/*` are private packages that do not exist on the public npm registry,
> so it always fails with `ERR_PNPM_META_FETCH_FAIL`. **That is a DSH ecosystem
> limitation, not something this plugin causes.** Route 1 below is the one that works.

### Route 1: the install script (recommended)

Download `dsh-purge-nolimit-2.3.32-dsh022.tar.gz` from
[Releases](https://github.com/L1daye/dsh-purge-nolimit/releases), then in PowerShell:

```powershell
# with the script and the tarball in the same directory
.\scripts\install-standalone.ps1 -Tarball .\dsh-purge-nolimit-2.3.32-dsh022.tar.gz
```

The script does the whole sequence: back up, stop the host, verify SHA512, extract,
patch `package.json`, rewrite all three lockfiles, check `cordis.patch.yml`, restart
the host, then read the status.

```
[1]  validate tarball / profile / host
[2]  back up to %USERPROFILE%\dsh-purge-install-backup-<timestamp>
[3]  stop the host
[4]  compute SHA512 (written into the lockfile integrity)
[5]  extract into node_modules/dsh-purge
[6]  patch package.json (dependency + bundles)
[7]  rewrite the three lockfiles
[8]  check cordis.patch.yml
[9]  verify key files
[10] start the host
[11] read /dsh-purge/status
```

**It only touches the target profile, and every step is preceded by a backup.**

Common flags:

```powershell
# see what would happen, change nothing
.\scripts\install-standalone.ps1 -Tarball .\pkg.tar.gz -DryRun

# install into the web profile
.\scripts\install-standalone.ps1 -Tarball .\pkg.tar.gz -Profile web

# do not restart automatically
.\scripts\install-standalone.ps1 -Tarball .\pkg.tar.gz -NoRestart
```

**After it finishes, open the host and click dsh-purge next to the session title,
then Clean, then Apply** - that writes the host patches, which the script leaves to
you on purpose.

### Route 2: manual (only if the script cannot run)

<details>
<summary><strong>Expand the manual steps</strong></summary>

**Prerequisite**: the tarball from Releases, and your `$DSH_HOME`
(usually `%USERPROFILE%\.dsh`).

**1. Stop the host**, tray included.

**2. Extract into the plugin directory:**

```powershell
$home = "$env:USERPROFILE\.dsh"
$prof = "$home\profiles\desktop"
Remove-Item "$prof\node_modules\dsh-purge" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory "$prof\node_modules\dsh-purge" -Force | Out-Null
tar -xzf .\dsh-purge-nolimit-2.3.32-dsh022.tar.gz -C "$prof\node_modules\dsh-purge"
```

**3. Patch the profile `package.json`** (`$prof\package.json`) in two places:

```json
{
  "dependencies": {
    "dsh-purge": "file:C:/absolute/path/dsh-purge-nolimit-2.3.32-dsh022.tar.gz"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-purge"]
    }
  }
}
```

**4. Rewrite the three lockfiles.** This is the painful step - `integrity` must be
recomputed:

```powershell
# SHA512 of the tarball, Base64 (not hex)
$sha = [System.Security.Cryptography.SHA512]::Create()
$fs = [System.IO.File]::OpenRead("C:\absolute\path\pkg.tar.gz")
$b64 = [Convert]::ToBase64String($sha.ComputeHash($fs))
$fs.Dispose()
"sha512-$b64"
```

The three files: `pnpm-lock.yaml`, `node_modules\.pnpm\lock.yaml`, and
`node_modules\.modules.yaml` (the last one is JSON).

**Use the script instead.** Hand-editing easily leaves stale entries and puts pnpm
into an inconsistent state.

</details>

### Verifying the install

```powershell
# 1. files present
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-purge\lib\core.js"

# 2. host sees it (after the host starts)
(Invoke-WebRequest http://127.0.0.1:<port>/dsh-purge/status -UseBasicParsing).Content
# expect: plugin=2.3.32-dsh022  patches=74/74
```

**A panel count of `74/74` means every patch is in place.** If you see a different
number, press Apply and restart once.

### Why `dsh plugin add <github-url>` does not work

```
ERR_PNPM_META_FETCH_FAIL
GET https://registry.npmjs.org/@deepseek-ai%2Fdsh-hooks-codex: fetch failed
```

`dsh plugin add` reinstalls the whole dependency tree, and `@deepseek-ai/*` are
private packages bundled with DSH that do not exist on public npm. A proxy does not
help - **the package simply is not there.**

**No DSH plugin should be installed that way on the desktop build.** Use Route 1.

<details>
<summary><strong>Why the Release tarball differs from the GitHub source archive</strong></summary>

The contents are **byte-equivalent** (measured: 135/135 files, identical hashes after
newline normalisation); only the compressed artifacts differ:

|  | GitHub auto-archive | Release tarball |
| --- | --- | --- |
| Top directory | `dsh-purge-nolimit-main/` | none (flat) |
| Line endings | Git converts to LF | CRLF kept |
| gzip | GitHub's | Windows tar |

**Either works** - the script computes the integrity itself.

</details>

## Preview

**dsh-purge** sits next to the session title. Clicking it opens the right panel with two pages: **Clean** and **Drill**. Light / dark switchable. Patches expand in groups; progress counts only what is really applied.

**Clean · patch overview**

All 88 patches grouped with live status; version and progress at the top, the eight apply stages below.

![Clean · patch overview](docs/preview/dock-clean.png)

**Patch detail**

Per-patch status. Shown here: all 22 prompt-layer patches applied.

![Patch detail](docs/preview/settings.png)

**Rule sets**

Workspace policy plus enabling and editing local `AGENTS.md` / `CLAUDE.md`.

![Rule sets](docs/preview/rules.png)

**Drill · environment**

Toolchain paths, egress status, platform mode.

![Drill · environment](docs/preview/dock-drill.png)

**Drill · asset mapping**

Scan results sorted by ease of exploitation, filterable by port, fingerprint and scope.

![Drill · asset mapping](docs/preview/dock-assets.png)

| Area | Purpose |
| --- | --- |
| dsh-purge | Button next to the session title; opens or collapses the right panel |
| Clean | Patches, prompt, rule sets |
| Drill | Environment and asset-mapping pages (auto-authorised, no countdown) |
| Patches | Grouped status; apply, revert or uninstall |
| Prompt | Edit `prompt-inject.md`, used as the session override section |
| Rule sets | Multiple `AGENTS.md` / `CLAUDE.md`; enabling writes to `$DSH_HOME`, deleting removes from the list |

---

## Layout

```
bin/                 CLI
lib/                 patch table, apply engine, injection, observability, probe
  core.js            ALL_PATCHES (88) + apply engine + targetFiles
  index.js           cordis plugin entry, HTTP routes, systemPrompt waterfall
  identity.js        identity detection, preset recognition, injection rewriting
  verify.js          flight recorder + timeline
  probe.js           injection probe (2.3.29+)
  refusal-retry.js   refusal retry (2.3.25+)
  continue-retry.js  auto-continue and failure retry
  armor-scorer.mjs   refusal detector (58 Chinese markers + 22 English patterns)
  redteam/           drill platform, 19 modules
presets/
  redteam/           red-team command preset
  unrestricted/      unrestricted mode (2.3.17+)
test/                20 test files / 163 cases
client.js            sidebar (React, prebuilt)
cordis.patch.yml     profile-level patch declaration
```

Runtime files live under `$DSH_HOME`: `prompt-inject.md`, `rules/`, `redteam/`, `dsh-purge/` (containing `probe.json`, `refusal-retry.json`, `refusal-retry.log`, `continue-retry.json`).

Without `DSH_HOME`, the `.dsh` next to the dsh installation is preferred, then `~/.dsh`. Web and desktop each use their own home.

---

## Usage

```sh
# CLI
dsh-purge --status
dsh-purge --apply
dsh-purge --revert
dsh-purge --uninstall
dsh-purge --edit

# Chat
/purge status | apply | revert | uninstall | edit | help
/rules list | use <id> | create <id> | delete <id> | reset | help
/rewind
/verify [rounds]      # behaviour-level armour check for recent rounds
/preflight            # read-only patch precheck before apply
/trace [rounds]       # armour timeline, aggregated per round

# Model tools
purge_status   purge_apply   purge_revert   purge_audit
purge_verify   purge_preflight   purge_trace
```

### HTTP routes

| Route | Purpose |
| --- | --- |
| `GET /dsh-purge/status` | Patch status, panel counts, conflict detection |
| `GET /dsh-purge/audit` | Full-break self-check (11 source-level items) |
| `GET/POST /dsh-purge/probe` | Injection probe: `POST` mints a nonce, `GET` reads the verdict, `DELETE` clears |
| `GET/POST /dsh-purge/retry` | Refusal-retry switch: `{"refusalRetry":true,"refusalMax":3}` |

---

## New modules

### Injection probe (probe, 2.3.29+)

**The problem**: patched files and registered sections only prove the **host side is ready**. The real chain is disk → assembly → model, and any break in it still looks fine in the UI.

```sh
# 1. Mint a probe (30-minute TTL)
curl -X POST http://127.0.0.1:PORT/dsh-purge/probe
# → {"nonce":"purge-a1b2c3d4","ttlMs":1800000}

# 2. Open a new session and say anything

# 3. Read the verdict (no model involvement — it reads the session log)
curl http://127.0.0.1:PORT/dsh-purge/probe
# → {"active":true,"injected":true,
#    "injection":{"reason":"newest-session-carries-probe",
#                 "sessions":[{"system_bytes":25823,"has_probe_tag":true,"has_nonce":true}]}}
```

**Four actionable verdicts**:

```
newest-session-carries-probe     ✅ fully wired
probe-section-missing            the section never registered
nonce-mismatch                   the probe was recreated after this assembly
no-sessions                      no session yet
```

The judgement reads the system prompt out of `~/.dsh/sessions/**/*.zstd`, so it does not depend on the model cooperating. Measured: `sys=25823` with the probe versus `sys=25714` without — 109 characters, exactly the block.

### Refusal retry (refusal-retry, 2.3.25+)

When the model starts hedging, append a nudge and let it answer again. **Off by default.**

```sh
curl -X POST http://127.0.0.1:PORT/dsh-purge/retry \
  -H 'content-type: application/json' \
  -d '{"refusalRetry":true,"refusalDecompose":true,"refusalMax":3}'
```

**Difference from the upstream community fork**: they wrap `llm/stream`, buffer the opening text, detect a refusal, discard it and re-run — the operator only ever sees the final answer. **DSH 0.2.2 has no `llm/stream` waterfall**, and `agent/pre-step`'s `{kind:"reject"}` merely ends the turn without retrying. This build therefore uses `agent.followup(nudge)`: the operator sees an extra turn, in exchange for a proven mechanism.

**Three nudges**:

```
1st  RETRY_NUDGE      ask for the technical answer, ending with "要现在执行吗？"
2nd  FRAME_NUDGE      switch to a fiction frame (local fixture, character voice)
3rd  DECOMPOSE_NUDGE  only the smallest deliverable (optional)
```

**Detector**: 17 rules, including Chinese **post-object negation** (这条我不做 / 这份我不出 / 结论：这条我不做). A long technical answer mentioning prompt injection is not treated as a refusal.

**Two-layer budget**: the same seq never retries twice, plus a lifetime cap (default 12) that survives resets, so a model that keeps refusing cannot loop forever.

### Atomic writes (2.3.28+)

```js
atomicWriteSync(fp, content, "utf8", { mode: 0o600, durable: true })
atomicCopyFile(src, dst)   // permissions follow the source
```

Three fixes:

- **Copy preserves the source mode**: a `0600` private config is no longer widened to `0644` by umask, and a `0755` launcher keeps its exec bit.
- **rename backoff**: `EPERM` / `EACCES` / `EBUSY` on Windows (panel polling, AV scanners) retry five times at 50/100/150/200 ms.
- **UUID temp names**: concurrent writes to one target no longer collide, and failures clean up.

---

## Responsiveness

DSH runs Bash calls in a batch sequentially. An older dsh-purge raised the default foreground wait from 60 s to 10 minutes, so one slow command made every later call wait too. Patch #21 restores marked plugin values to the official 60 s.

On macOS/Linux `dsh web`, for faster tool results add this to `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: bash-sandbox
  config:
    timeoutMs: 10000
```

With the standard jobs service and `promoteOnTimeout: true`, an unfinished command returns a background job id after 10 s. Read it with `job_output`, stop it with `job_kill`.

New sessions can also default to Low reasoning:

```yaml
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: low
```

---

## Local checks

```sh
# Syntax
node --check lib/index.js
node --check lib/core.js
node --check lib/probe.js
node --check lib/refusal-retry.js

# Full suite (163 cases)
node --test

# Panel status (while the host is running)
curl http://127.0.0.1:PORT/dsh-purge/status
```

---

## How it works

### Four layers

```mermaid
flowchart TB
  subgraph P["1. Prompt layer (every round)"]
    P1["system-prompt/assemble waterfall"]
    P2["injects MERGED-1.1.71 · 34426 B"]
    P3["probe section (when probe.json is live)"]
  end
  subgraph E["2. Engine layer (on apply)"]
    E1["88 byte patches"]
    E2["atomic writes: permissions kept · rename backoff · unique temp names"]
  end
  subgraph G["3. Gate layer"]
    G1["range / cheats / approvals → all allowed"]
  end
  subgraph O["4. Observability layer"]
    O1["verify flight recorder"]
    O2["preflight anchor check"]
    O3["trace timeline"]
  end
  subgraph R["During conversation"]
    R1["refusal-retry: appends a nudge on a refusal"]
    R2["armor-scorer: scores every reply → armour badge"]
  end
  P --> E
  E --> G
  G --> O
  G -.-> R
  O -.->|feedback| P
```

### Apply

On start, or when you press **Apply** — same path:

```mermaid
flowchart TD
  A["Start / press Apply"] --> B{"Patch already effective?"}
  B -->|yes| C["Skip"]
  B -->|no| D["backupAll<br/>write .dshpurge.bak for every target"]
  D --> E["refreshStaleBaksForUpgrade<br/>criterion: is the original anchor back?"]
  E --> F["Replace per the 88 patches<br/>atomicWriteSync: keep mode · retry rename"]
  F --> G["Overwrite the shim · repair the CLI entry"]
  G --> H["Inject the encrypted default prompt"]
  H --> I["reapply replays on every start<br/>skips agent presets, leaves user config alone"]
```

**Two details that are easy to get wrong**:

- **The `.bak` refresh criterion is "is the original anchor back"**, not "does the file still contain `[dsh-purge]`". Whole-sentence replacement patches leave no marker behind, so marker-based judgement mistakes a patched file for a vendor update and overwrites a usable backup.
- **`reapply` replays on every start**, but it **skips `$DSH_HOME/.agent-presets/`** — that is our own configuration, not host source, and must not take part in rollback.

### Per-round injection and retry

```mermaid
flowchart TD
  L["Rule library: enabling a set writes prompt-inject.md"]
  W["Local rules: tick the current directory's AGENTS.md / CLAUDE.md"]
  P["Workspace policy: strict / fallback / always"]

  A["New round"] --> B{"prompt-inject.md non-empty?"}
  B -->|yes| C["Injection = prompt-inject.md (A)"]
  B -->|no| D{"Ticked, non-empty local md in cwd?"}
  D -->|yes| E["Injection = ticked workspace md (B)"]
  D -->|no| F["Injection = encrypted slot default (D)<br/>source: refresh / ensure / sealed / empty"]
  C --> G{"Workspace baseline policy (C)"}
  E --> G
  F --> G
  G -->|strict| H["Drop the DSH workspace baseline section"]
  G -->|fallback default| I{"Any user injection above? (A or B)"}
  G -->|always| J["Keep the DSH workspace baseline section"]
  I -->|yes| H
  I -->|no| J
  H --> K["Assemble the final system prompt"]
  J --> K

  K --> M["+ probe section (when probe.json is live, order 9000)"]
  M --> N["Model generates a reply"]
  N --> O{"refusal-retry check"}
  O -->|refusal, within budget| Q["agent.followup(nudge)<br/>attempt 1 → 2 → 3"]
  Q --> N
  O -->|normal| R["Output"]
  N --> S["armor-scorer scores it<br/>→ armour badge next to the input box"]

  L -.-> B
  W -.-> D
  P -.-> G
```

**Three new steps**:

- **The `probe` section** is injected only while `probe.json` exists and has not expired (30 minutes). Use it to answer "did the injection actually arrive" — `GET /dsh-purge/probe` reads the session log and returns a verdict without depending on the model cooperating.
- **`refusal-retry`** is off by default. On a refusal it appends a nudge via `agent.followup`, up to three stages (ask for the answer → switch to a fiction frame → ask for the smallest component). The same seq never retries twice, and a lifetime cap prevents loops.
- **`armor-scorer`** is read-only and never touches the conversation. It writes its verdict into `sessionProjections`, and the badge turns red or green accordingly.

---

## Rollback

- Every target file is backed up as `<file>.dshpurge.bak` before applying.
- Revert (or `/purge revert`) restores from the backup and deletes it; with no backup, the lines this plugin wrote into the shim are removed.
- `prompt-inject.md` is a user file and is preserved on revert.
- Uninstall reverts first (if applied), then removes the injection file, rule library and the plugin itself.
- Applying repeatedly is idempotent.
- **Agent presets do not participate in revert** (2.3.23): files under `$DSH_HOME/.agent-presets/` are our own configuration and are left untouched.

---

## Path discovery

The host surface is resolved first: `web` / `desktop` (`gui` / `tui` are reserved and fall back to web until separately supported).

**Web:**

1. `DSH_HOME` / `DSH_BASE`
2. `.dsh` next to the dsh launcher
3. `npm prefix -g` / `npm root -g`
4. Nested `@deepseek-ai/dsh/node_modules/@deepseek-ai`
5. System default `~/.dsh`

**Official desktop:** only the currently running official desktop installation is modified. Apply restarts it once on success. Community desktop builds are not supported.

When no target is found the plugin asks you to set `DSH_BASE` and leaves files alone.

---

## Updates

Release notes for this fork live in [release-notes.md](./release-notes.md) (per-version since 2.3.17) and in [GitHub Releases](https://github.com/L1daye/dsh-purge-nolimit/releases).

The original author's channel and repository: [t.me/LLM_PoJia](https://t.me/LLM_PoJia) · [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge).

**This fork's contact**: [lidayet94@gmail.com](mailto:lidayet94@gmail.com) · [@L1daye](https://github.com/L1daye). Commercial licensing: [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md).

The original may not be resold; forks must attribute.

---

## Developer docs

Read **[AGENTS.md](./AGENTS.md)** before changing this repository — 34573 B covering:

- Architecture and file layout
- How to write a patch (four hard constraints)
- The five-layer verification method
- **20 known traps** — every one actually hit in practice, with symptoms, root cause, fix and measured data
- Release process and the two install routes
- Behavioural probe design

**The five most valuable traps**:

| Trap | In one line |
| --- | --- |
| #16 | `agent/status`'s payload has **no agent** — the listener never runs |
| #17 | The retry counter reset every turn causes **infinite retry** |
| #18 | `addPromptSection` after an early `return` silently does nothing |
| #19 | "The model echoed it" is not evidence of injection |
| #20 | A session size cap causes **false negatives** |

---

Thanks to the [LINUX DO](https://linux.do) community

and to the original author [@YuJunZhiXue](https://github.com/YuJunZhiXue) — without the original there would be no fork.
