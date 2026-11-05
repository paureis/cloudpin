# Changelog

All notable changes to cloudpin are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

Versions 1.0.0 to 1.2.0 are in [docs/changelog-1.0-1.2.md](docs/changelog-1.0-1.2.md), and 0.1.0 to 0.4.2 in
[docs/changelog-0.x.md](docs/changelog-0.x.md).

## [Unreleased]

### Added

- [THREAT_MODEL.md](THREAT_MODEL.md) (#84): what cloudpin protects against, what it trusts, the code behind each control,
  and what it deliberately doesn't try to stop.
- A standalone `cloudpin.exe` for 64-bit Windows (#96), in each GitHub Release as `cloudpin-X.Y.Z-win-x64.zip`
  (listed in `SHA256SUMS` and covered by the signed attestation): a Node.js single executable application with
  cloudpin and its two dependencies inside, built with the exact Node.js 26 pinned in `scripts/exe-node-version.txt`,
  so it needs no Node.js installed. It names its own upgrade: `winget upgrade paureis.cloudpin` when winget installed
  it, otherwise to download the latest zip. Nightly opens an issue when a newer Node.js 26 security release appears.
- winget manifests for `paureis.cloudpin` (#96) in `packaging/winget/`: a portable zip installing `cloudpin.exe` as
  the `cloudpin` command. `node scripts/bump-installers.mjs X.Y.Z --winget <dir>` renders them for a release, after
  checking the exe zip against `SHA256SUMS`, and `docs/winget.md` lists the maintainer's steps to submit them.
- MCP: two more read-only tools (#112). `cloudpin_doctor`: `cloudpin doctor --json`'s report, so an agent can tell you
  why cloudpin isn't guarding (IDs shortened; it skips the cache check, which writes a file). `cloudpin_switch_plan`: the
  plan `cloudpin switch --json` prints without `--yes`, for you to run, pinned IDs in full; nothing is run. The plugin's
  skill names both.
- Docs: [Guard a Claude Agent SDK app](docs/agent-sdk.md) (#142). An app that loads project settings needs no code;
  for one that loads none, there is a Python and a TypeScript `PreToolUse` callback that denies on every error.
- `cloudpin switch [--yes] [--json] [--only <clouds>]` (#14) switches each pinned CLI to its pinned account. It shows a
  plan, asks once, runs each CLI's own switch command without a shell (`az account set`, `gh auth switch --hostname
  --user`, `vercel teams switch <slug>`, `gcloud config set ... --quiet`, `kubectl config use-context` and, for a pinned
  namespace, `set-context --current --namespace`), then checks again, exiting 0 only when every pinned, installed CLI
  matches. When several kube contexts or AWS profiles fit, you pick one by number in a terminal. What it won't do is named for you: a missing login, `supabase link`, a Wrangler config edit, or
  something that overrides the switch (`GH_TOKEN`, `CLOUDSDK_CORE_PROJECT`, `AWS_ACCESS_KEY_ID`, `VERCEL_ORG_ID`,
  `HELM_KUBECONTEXT`, gcloud impersonation, a scope in `vercel.json`, in any spelling on Windows). AWS profiles are
  found in the AWS config file, reading only profile names, `sso_account_id` and `role_arn` (never the credentials
  file). `--json` prints the plan, what ran and the `check --json` report after, and never prompts. An agent's `cloudpin switch` asks you first, with `--yes` too and however it is spelled (agents whose
  hooks can't ask are told to ask you to run it). A blocked command's fix also suggests it, except for Supabase and
  Wrangler.
- `cloudpin shell-init` also defines a `cloudpin` function (#14), so `cloudpin switch` can set `AWS_PROFILE` in your
  shell: it applies only an `AWS_PROFILE=<name>` line from a temporary file (never eval), and passes every other command
  straight through. The guarded shell functions now look for the cloudpin executable with `type -P` (bash) or
  `whence -p` (zsh), so that function can't make them think cloudpin is still installed after an uninstall.

### Security

- A guarded CLI in text a line runs was never checked: `echo '...' | bash`, `cat <<X | bash`, `trap '...' EXIT`,
  `${x:-$(az ...)}`, `bash -c -e '...'`, `alias` on a later line, `Set-Alias`. Each is now read. What cloudpin can't read
  stops the CLIs the line names as "can't tell" when a pin is in play: `eval "$(...)"`, `sh -c "$(...)"`, `source <(...)`,
  unknown text piped into a shell, a bare `$c` as a command. A line that names none has nothing to stop, so
  `curl ... | bash` passes. In PowerShell, a variable changed inside a block is unknown after it (#163).
- A call after `set -a`, `export X+=y`, `local -x`, `${env:X}=`, `Set-Item env:X`, `[Environment]::SetEnvironmentVariable`
  or `Remove-Item Env:X` was checked without what they set. Each is now followed. What cloudpin can't read stops later
  calls as "can't tell" when a pin is in play: `. file`, `source file` and `export $(...)` for any CLI, `read X` and
  `$env:X` inside a block for the CLI that X picks the account of (#163).
- A call after `cd -- x`, `pushd x` or `Set-Location x` was checked against the wrong pin file. Each spelling is now
  followed, and a folder cloudpin can't read in advance (`cd "$(...)"`) stops later calls as "can't tell" when a pin
  file is in sight (#163).
- An agent's `cloudpin exec -- bash -c 'gh ...'` or `cloudpin exec -- npx gh ...` was read as an unguarded `bash` or `npx`,
  so it could run on the wrong account. What `cloudpin exec` starts is now read as a call of its own (#14).
- `cloudpin explain` (text and `--json`) and the MCP `cloudpin_check` tool no longer repeat a token or password from
  the command line (#134): `--token`, kubectl's `--token` and `--password`, helm's `--kube-token` and the other
  credential flags are masked, as in cloudpin's own block messages, also inside `cmd /c`, `powershell -Command` and
  `-EncodedCommand`. The verdict is still worked out from the real values.

### Fixed

- Short flags joined with `=` (for example, `wrangler deploy -e=production`) were ignored by the shared
  argument reader, so cloudpin could resolve the account without the requested environment (#118). It now
  reads the joined form only for the CLIs that accept it, starting with Wrangler.
- Vercel: `-y` inside a short group (`vercel project inspect -dy`) asks on a protected environment, since it can create
  and link a project, and `vercel teams change` and the `team` alias are exempt like `teams switch` (#148).
- Help no longer exempts a command that runs anyway (#153): a kubectl or helm plugin given `--help` (it gets the flag
  as an argument), a value flag that takes it (`gh secret set X --body --help`), and Wrangler's `--help false` and
  `--no-help`. `gh ... --web --help` is checked as well, at the cost of one check.
- kubectl: `--all_namespaces` counts as `--all-namespaces`, as kubectl reads it (#153).
- kubectl and helm: a long flag that may take the next word as its value no longer hides the target (#153).
  `kubectl logs pod --container -n x` sets no namespace, since `-n` is the container, but cloudpin read namespace `x`.
  cloudpin now knows the long flags that never take a value (`--watch`, `--all`, `--force`, ... for kubectl 1.36 and
  helm 3 and 4). After any other long flag without `=`, when the next word starts with `-` and it or a later word would
  pick the target, the command stops as "can't tell" and names the flag, which reads fine as `--flag=value`.
- Vercel: with services on, a command in a service's folder is also checked against the link of the parent project,
  which is the one Vercel uses (#153). That holds for every command that reads a link, `vercel dev` included.
  Services are on with `VERCEL_USE_EXPERIMENTAL_SERVICES`, or the parent's config setting them, and a config only Vercel
  can read (`vercel.toml`, `vercel.ts`, ...) counts too, at the cost of one check.
- Vercel: `vercel deploy <dir>`, a bare `vercel <dir>`, `vercel pull <dir>` and `vercel dev <dir>` are checked against
  the link of the folder they name, not the one they run in (#147). A folder known only when the command runs
  (`vercel deploy "$D"`) stops as "can't tell".
- kubectl: a kuberc alias whose arguments hold a short flag group (`-itnprod`, `-iA`, `-is <url>`) is read as the
  group it is, and a short flag's value is the next word whole, so `kubectl logs pod -c -n x` is not namespace x. The
  user's own short flags after an alias follow the alias command's letters (#140).
- Wrangler auth profiles (#103): a command run with `--profile`, or in a folder bound by `wrangler auth activate`,
  is checked against that profile's login and its own account cache, not the default one. When nothing else names
  the account and Wrangler can't be asked about the profile (a `--profile` the folder isn't bound to, with no API
  token or key in the environment or the project's `.env` files), it stops the command. `cloudpin explain` names the
  profile and why. Profiles are read from Wrangler's config folder, which an `XDG_CONFIG_HOME` or (on Windows)
  `APPDATA` set in `.env` moves.
- Cloudflare account variables (#119): a command line that sets `CLOUDFLARE_ACCOUNT_ID`, `CF_ACCOUNT_ID`,
  `CLOUDFLARE_ENV`, `WRANGLER_CACHE_DIR`, `DOTENV_KEY` or another variable that picks Wrangler's account to a value
  cloudpin can't know (`$(...)`, backticks, `$OTHER`) stops as "can't tell" instead of being checked without it.
- Windows: variable names are read without regard to case, as Windows and the CLIs do (#119), so a lowercase
  `gh_token`, `aws_profile`, `azure_config_dir` or `cloudflare_account_id` counts. One variable set in two spellings
  to different values stops as "can't tell".
- Windows: cloudpin's own variables are read without regard to case too (#136): a lowercase `cloudpin_env`,
  `cloudpin_branch`, `cloudpin_confirm` or `cloudpin_skip` you set counts, and an agent still can't set or unset
  `CLOUDPIN_ENV` or `CLOUDPIN_BRANCH` in any spelling. The read-only check on a protected environment reads folded
  names, so a lowercase `aws_config_file` counts there as well.
- Agent hooks: what `cloudpin exec` starts is read as a command of its own (#14), so a call behind a wrapper or a shell
  inside it, as in `cloudpin exec -- bash -c 'az ...'` or `cloudpin exec -- npx wrangler ...`, is checked instead of
  passing as an unguarded `bash` or `npx`.
- Agent hooks: a `cloudpin` call whose subcommand is only known when it runs (`cloudpin $x`) asks you first (#14), since
  it may be `cloudpin use` or `cloudpin switch`. Cursor's matcher finds a CLI in any case (`AZ.CMD`).

## [1.2.1] - 2026-10-29

Fixes agent-hook gaps where a command could run on the wrong account without being checked (1.2.0 and earlier have
them). Please upgrade.

### Fixed

- Agent hooks: a heredoc inside `$( )`, as in `git commit -m "$(cat <<'EOF' ... it's ... EOF)" && az ...`, no
  longer hides the calls after it. Carriage returns are dropped as Git Bash does, `(( ))` and `$(( ))` are read as
  arithmetic, and `$'...'` is decoded ([#161](https://github.com/paureis/cloudpin/issues/161)).
- Agent hooks: an account flag whose value is only known when the command runs (`--subscription $(cat f)`,
  `--context="$X"`, an unknown `$VAR` or `"$@"`) gives "can't tell" instead of being read as empty. A variable set
  earlier on the same line is substituted, which also ends a false block. An unquoted `$( )` counts as one word that is
  not a flag ([#160](https://github.com/paureis/cloudpin/issues/160)).
- Agent hooks read PowerShell commands with PowerShell's rules: Claude Code's and Copilot's PowerShell tools, and on
  Windows the agents that don't name their shell (Codex, Gemini CLI, Cursor, Antigravity) are read both ways, and every
  call either reading finds is checked. Each call is also checked as Windows PowerShell 5.1 would pass it. `cloudpin
  explain --powershell` and `cloudpin_check`'s `shell` argument take the dialect
  ([#159](https://github.com/paureis/cloudpin/issues/159)).
- Agent hooks find the call behind wrappers and runners: `env`, `sudo`, `nice`, `timeout`, `exec`, `command`,
  `xargs`, `watch`, `npx`, `npm exec`, `pnpm`, `yarn`, `bunx`, `cmd /c`, `powershell -Command` and
  `-EncodedCommand`, `Invoke-Expression` and `Start-Process` ([#162](https://github.com/paureis/cloudpin/issues/162)).
- gcloud: `--impersonate-service-account` (and its variable and property) is checked as the account the command runs
  as, the last one in a delegation chain. An access token or token file gives "can't tell" for an account pin; a
  project pin is still checked ([#165](https://github.com/paureis/cloudpin/issues/165)).

### Changed

- These fixes fail closed, so some lines that ran before now stop as "can't tell": `... | xargs <guarded CLI>`,
  cmd's `%VAR%`, `^`, `if`, `for` and `start`, an `Invoke-Expression` or `-EncodedCommand` that can't be read, and on
  Windows a bash variable or `$env:X` in a command from an agent that doesn't name its shell. Run such a command
  yourself, or write the values out.
