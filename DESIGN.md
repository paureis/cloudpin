# cloudpin — design

> A seatbelt for your cloud CLIs: stops you, or your AI agent, from running commands on the wrong account.

Decisions reached in the design interview of 2026-10-07. Anything marked **(verify)** must be checked
against current official docs during the build, not assumed.

## Problem

`az`, `aws`, `gcloud`, `vercel` and `gh` silently act on whichever account was logged in last. With
several accounts on one machine, a deploy or delete lands on the wrong one. AI agents make it worse:
they run these commands for you and never ask.

## Why this project

Before choosing it we checked the alternatives (October 2026): session-replay viewers, claim checkers,
hallucinated-package guards and knowledge-cutoff updaters each already have 3 to 7 open-source versions.
We found no popular standalone tool for per-project cloud account pinning.

## Decisions

| Area | Decision |
|---|---|
| Name | `cloudpin` (free on npm; avoided "cloudguard", a Check Point product) |
| Stack | TypeScript on Node, published to npm, works on Windows, macOS and Linux |
| Config | Committed `.cloudpin.yml`; pins stable IDs, with friendly names as comments; created by `cloudpin init` from the current logins |
| CLIs | az (subscription + tenant ID), aws (account ID), gcloud (account + project ID), vercel (team ID), gh (user + host) |
| Terminal | Shell wrappers for bash, zsh and PowerShell, enabled by one line in the shell profile; plus `cloudpin check` for scripts and CI |
| Speed | Identity results cached; cache invalidated when the CLI's own config/credential file changes |
| Agents | Every agent with a real blocking pre-command hook (Claude Code, Cursor; Codex, Gemini CLI and Copilot CLI **(verify)**), via `cloudpin install-hook <agent>`. Agents without a blocking hook get documented `cloudpin check` integration, never a fake hook |
| Block rule | On mismatch, block every command except login, logout, switch, whoami, `--version` and help |
| Override | `CLOUDPIN_SKIP=1` works in the terminal; ignored in agent-hook mode |
| Scope | The full product at launch; iterate on issues afterwards |
| License | MIT |
| Authorship | Commits carry `Co-Authored-By: Claude`; the README says it was built with Claude Code as a pair programmer |

## Edge cases

- No `.cloudpin.yml` found: cloudpin does nothing.
- Monorepos: the nearest `.cloudpin.yml`, searching upward from the current folder, wins.
- A pinned CLI isn't logged in: block, with the message "log in as X".
- A pinned CLI isn't installed: skip it.
- A command picks the account itself (`--subscription`, `--profile`, `--scope`, `--project`, or env vars such
  as `AWS_PROFILE` / `CLOUDSDK_CORE_PROJECT`): check that account, not the default one.
- cloudpin only ever reads identity, never prints tokens, and never logs in or changes accounts.

## Repo and release

- Private `paureis/cloudpin`, local at `<repo>`.
- Go public only when all of these are done:
  1. Every CLI and every supported agent tested on real accounts (Windows), with CI green on Windows, macOS and Linux.
  2. About a week of the owner using it on real projects.
  3. Safety review: read-only, no token output, switching never blocked.
  4. README with a short animated demo, one-line install, clean uninstall, and the origin story.
  5. `cloudpin` 1.0.0 published to npm.
  6. **Disk cleanup (owner request, 2026-10-08):** delete the test tools folder `~\.cloudpin-testbed`
     (gcloud and agent CLIs installed only for testing), `dist/`, any `cloudpin-*`/`tmp.*` folders left in the
     temp directory, and stale git worktrees; report the space freed to the owner.
  7. **Before flipping to public:** remove personal machine details from `CLAUDE.md` and `HANDOFF.md` (paths,
     account names, the owner's subscription layout) or move those files out of the repo; enable private
     vulnerability reporting (`SECURITY.md` links to it); after the first npm publish, check that the README
     images and badges render on npmjs.com.
- Then: make it public, pin it on the profile, post a launch (r/devops, r/ClaudeAI, Show HN).
