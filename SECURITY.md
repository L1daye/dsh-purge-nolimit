# Security Policy

## What this project is

`dsh-purge` is a plugin for the DeepSeek Harness desktop and web builds. It patches
host source files inside your own installation and injects a system prompt. It does
not run a service, accept remote connections, or send anything anywhere.

The only network access it makes is an optional version check against this
repository's own GitHub releases, and only if you turn that on.

## Reporting a vulnerability

Email **lidayet94@gmail.com**. Do not open a public issue for anything that could be
exploited before a fix ships.

Useful in a report:

- the version (`dsh-purge --status` prints it)
- host version and OS
- what you did, what happened, what you expected
- if it involves a patched file, the relevant diff

Do not include your API keys, prompt text, or full configuration files.

You should get a reply within a few days. This is a single-maintainer project, so
there is no formal SLA and no bug bounty.

## Scope

In scope:

- the patch engine writing outside the target profile
- restore or revert leaving a host in a broken state
- the lockfile rewrite corrupting a profile
- command injection or path traversal through the HTTP routes
- anything that leaks the encrypted prompt bundle

Out of scope:

- the host patches doing what they say they do (that is the point of the plugin)
- antivirus flagging `redteam-tools-20.tar.gz`, which contains third-party binaries
  such as nmap and hashcat
- issues that require the attacker to already have write access to your user profile
- upstream DSH bugs, which belong in the DeepSeek issue tracker

## Supported versions

Only the latest release gets fixes. This is a fast-moving fork; older builds are
superseded rather than patched.

| Version | Supported |
| --- | --- |
| 2.3.x (latest) | yes |
| older | no, upgrade |
