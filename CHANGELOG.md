# Changelog

Per-version notes live in [release-notes.md](./release-notes.md), which is the
canonical record (bilingual 中文 / English, newest first). This file only maps
versions to dates and points at it.

## Version scheme

`<major>.<minor>.<patch>-dsh<host minor>`

The `-dsh022` suffix means the build targets DeepSeek Harness 0.2.2.

## Releases

| Version | Summary |
| --- | --- |
| [2.3.32](./release-notes.md) | probe: fix a false negative when a session file exceeds the size cap |
| [2.3.31](./release-notes.md) | probe: read the verdict from the session log instead of asking the model |
| [2.3.30](./release-notes.md) | probe: register the section before the postPrompt early-return |
| [2.3.29](./release-notes.md) | new: injection probe (prove the prompt reached the model) |
| [2.3.28](./release-notes.md) | atomic writes: keep permissions, retry rename, unique temp names |
| [2.3.27](./release-notes.md) | refusal-retry: fix infinite retry caused by counter reset |
| [2.3.26](./release-notes.md) | refusal-retry: fix the event hook (agent/status carries no agent) |
| [2.3.25](./release-notes.md) | new: refusal retry (nudge the model when it hedges) |
| [2.3.24](./release-notes.md) | #91/#92 surfaces; patchStatus accepts options.surface |
| [2.3.23](./release-notes.md) | fix the agent preset reverting on every host restart |
| [2.3.22](./release-notes.md) | #92 three-form regex; anchor-based .bak refresh |
| [2.3.21](./release-notes.md) | .bak refresh judged by anchors, not markers (fixes rollback) |
| [2.3.20](./release-notes.md) | anchor regression test; restore patterns lost in the port |
| [2.3.19](./release-notes.md) | drop the deprecated toolFilter; preset becomes selectable |
| [2.3.18](./release-notes.md) | register presets explicitly (files on disk never appear) |
| [2.3.17](./release-notes.md) | ship the unrestricted agent preset |

Earlier spans (2.3.1 – 2.3.16, and the 1.x line) are described in
[release-notes.md](./release-notes.md).

## Unreleased

Nothing pending.
