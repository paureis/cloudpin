# Changelog

All notable changes to cloudpin are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
