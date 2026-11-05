# Changelog: 1.0 and 1.1

cloudpin's 1.0 and 1.1 releases, moved here from [CHANGELOG.md](../CHANGELOG.md) on 2026-11-04 to keep that file
short. Newer versions are listed there, and older ones in [changelog-0.x.md](changelog-0.x.md).

## [1.1.2] - 2026-10-19

Completes the 1.1.1 security fix for Windows. Please upgrade.

### Security

- Windows: CLIs installed by npm (vercel, wrangler, ...) no longer start a `node` found in the current folder. npm's
  `.cmd` shims run `node` by name when no node.exe sits beside them, and Windows looked for it in the current folder
  first. cloudpin now tells Windows not to search the current folder for any process it starts, including the command
  `cloudpin exec` runs, as PowerShell and Git Bash already do
  ([GHSA-3cf7-5v5w-q5vr](https://github.com/paureis/cloudpin/security/advisories/GHSA-3cf7-5v5w-q5vr)).

## [1.1.1] - 2026-10-18

A security fix for Windows. Please upgrade.

### Security

- Windows: cloudpin now runs each CLI it asks about (az, gh, vercel, aws, gcloud, kubectl, helm, supabase,
  wrangler), and the command `cloudpin exec` runs, by its full path from PATH, skipping empty and relative PATH
  entries. Before, Windows' own lookup checked the current folder first, so a file named like one of those CLIs
  inside a repository could run in its place when cloudpin checked a command there
  ([GHSA-3cf7-5v5w-q5vr](https://github.com/paureis/cloudpin/security/advisories/GHSA-3cf7-5v5w-q5vr)).

## [1.1.0] - 2026-10-16

Claude Code gets a one-step plugin, and any MCP agent can ask cloudpin before it acts.

### Added

- A Claude Code plugin (#15): `claude plugin install cloudpin --marketplace paureis/cloudpin` installs the hook, a
  read-only MCP server and a skill that tells the agent to check first and stop on a block. With the plugin enabled,
  `install-hook claude` declines and `doctor` warns if a settings hook would also run.
- `cloudpin mcp` (#15): a read-only MCP server (stdio) with `cloudpin_status` and `cloudpin_check`, for any agent that
  supports MCP. No new dependency.

## [1.0.0] - 2026-10-15

The first stable release: the `.cloudpin.yml` format is stable from here on (later versions only add sections and
keys), and every agent hook except Gemini CLI's is tested inside the real agent.

### Fixed

- Variables an agent sets earlier in its command line now count (#86). `export AWS_PROFILE=other; aws ...` and
  PowerShell `$env:AWS_PROFILE = 'other'; aws ...` were checked against the default account and ran on another; and
  `GH_TOKEN=$(cat other.token) gh ...` read the token as empty. cloudpin now follows `export`, `unset` and `$env:`
  through the line, and stops a command whose account depends on a value only known when it runs, saying why. Found
  in the threat-model review.
- Cursor: a command on your Cursor allowlist runs again when the account matches (#2). cloudpin answered `ask`, which
  stopped even allowlisted commands; it now answers `allow`, which Cursor treats exactly like having no hook (measured
  in Cursor CLI 2026.10.01: commands not on the allowlist still need your approval). Wrong accounts are still blocked.

### Added

- Antigravity hooks (#80): `cloudpin install-hook antigravity` guards Antigravity CLI, the IDE and Antigravity 2.0
  (`.agents/hooks.json`, or `~/.gemini/config/hooks.json` with `--user`). Google replaced Gemini CLI with Antigravity
  CLI for free and consumer accounts on 2026-06-18. The hook checks `run_command` and text typed into a running
  terminal; it asks rather than allows when nothing is wrong, so Antigravity's own approvals still apply.
- The Copilot CLI and Antigravity CLI hooks are tested inside the real agents (#3): a wrong pin blocks the command, a
  right one lets it run, and Antigravity's own approval still applies to commands you haven't allowed.
