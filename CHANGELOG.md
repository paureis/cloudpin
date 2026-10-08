# Changelog

All notable changes to cloudpin are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `cloudpin status`: each CLI's active account, the pins that apply here, and the installed agent hooks;
  `--json` for tools (the MCP server and editor extension build on it).
- Environments (#12): one `.cloudpin.yml` can pin several environments (`environments:`), chosen by
  `CLOUDPIN_ENV`, `cloudpin use <name>`, a `branches` mapping or the first listed. `cloudpin init --env <name>
  [--protected]` adds one; `status`, `check` and every message name the active environment.
- Protected environments: on the right account, commands that may change something ask first (a y/N prompt, the
  agent's own "ask" in Claude Code, Copilot CLI and Cursor, a block in Codex and Gemini CLI, `CLOUDPIN_CONFIRM` in CI).
  Read-only commands are listed per CLI and can be extended with `read_only:`.

### Changed

- The flat `.cloudpin.yml` format keeps working unchanged; it is now the single-environment case.

### Fixed

- An agent could skip the check by wrapping a command in `cloudpin exec` (shell mode, where `CLOUDPIN_SKIP` works);
  the agent hook now checks the wrapped command as the agent's.

## [0.1.0] - 2026-10-08

First public beta.

### Added

- `.cloudpin.yml` pins accounts per project for `az`, `aws`, `gcloud`, `vercel` / `vc` and `gh`; the nearest file
  above the current folder wins.
- Identity checks that follow each command's own flags and environment, including Vercel commands that touch both a
  team and a linked project.
- `cloudpin init`, `check`, `exec`, `shell-init` (bash, zsh, PowerShell), `hook`, `install-hook` and
  `uninstall-hook`.
- Agent hooks for Claude Code, Codex, Cursor, Gemini CLI and GitHub Copilot CLI.
- A five-minute identity cache that is dropped as soon as any account file, variable or flag changes.
- Plain "could not tell" messages when an account can't be determined, with the CLI's own reason.
