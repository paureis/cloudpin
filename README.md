# cloudpin

**A seatbelt for your cloud CLIs.** cloudpin stops you, or your AI coding agent, from running a command on
the wrong cloud account.

> Status: pre-release, not on npm yet. Everything below works and is tested; see
> [What works today](#what-works-today) for how each part was verified.

## The problem

`az`, `aws`, `gcloud`, `vercel` and `gh` quietly act on whichever account you logged into last. With a work
account and a personal one (or two clients) on the same machine, sooner or later you deploy to, or delete
from, the wrong place. AI agents make this more likely: they run these commands for you and never stop to ask
which account is active.

## How it works

Commit a small file to your project saying which accounts it uses. `cloudpin init` writes it for you from the
accounts you are logged into now:

```yaml
# .cloudpin.yml
azure:
  subscription: "3f2a0000-0000-0000-0000-000000000c91" # Acme Prod
  tenant: "8b1d0000-0000-0000-0000-00000000044e"
aws:
  account: "123456789012"
vercel:
  team: "team_x9KqZr" # acme
github:
  user: "acme-bot"
```

Before a cloud command runs, cloudpin asks the CLI which account *that command* would use, honouring its flags
(`--subscription`, `--profile`, `--scope`, `--project`) and environment (`AWS_PROFILE`, `GH_TOKEN`,
`CLOUDSDK_*`, a linked Vercel project), and compares the answer with the file:

- **Match:** the command runs, and you don't notice anything.
- **Mismatch:** the command is stopped, with the fix:

```text
cloudpin: blocked `gh pr merge 42`
  github is pinned in /code/acme/.cloudpin.yml
  - user: expected "acme-bot", active is "my-personal"
  fix: gh auth switch --user acme-bot
```

- **Can't tell** (a broken token, a network error): the command is stopped too, and cloudpin says so plainly,
  with the CLI's own reason and the command that shows what is wrong.

cloudpin only *reads* which account is active. It never logs in, never stores or prints credentials, and
always lets you log in and switch accounts.

## Protect your terminal

Add one line to your shell profile; remove it to uninstall:

```bash
eval "$(cloudpin shell-init bash)"      # ~/.bashrc  (zsh: shell-init zsh in ~/.zshrc)
```

```powershell
cloudpin shell-init pwsh | Out-String | Invoke-Expression   # in $PROFILE
```

To run one command anyway, on purpose: `CLOUDPIN_SKIP=1 <command>`.

## Protect your AI agent

```bash
cloudpin install-hook claude     # also: codex, cursor, gemini, copilot
```

This adds cloudpin's hook to the project's agent settings (`--user` for your personal settings), shows you the
file first, and keeps a backup. A blocked agent is told why and asked to check with you; agents cannot use
`CLOUDPIN_SKIP`. `cloudpin uninstall-hook <agent>` removes it.

## Scripts and CI

```bash
cloudpin check                   # exit 1 if any pinned account does not match
cloudpin exec -- vercel deploy   # run one command only if the account matches (exit 3 if blocked)
```

## What works today

| Part | Status |
|---|---|
| Azure (`az`), AWS (`aws`), GitHub (`gh`), Vercel (`vercel`, `vc`) | Working; tested on real accounts |
| Google Cloud (`gcloud`) | Working; tested against the real CLI with test configurations |
| `init`, `check`, `exec` | Working |
| Shell wrappers | Working; tested in bash and Windows PowerShell |
| Claude Code, Codex, Copilot CLI, Gemini CLI, Cursor hooks | Working against each agent's documented hook format; end-to-end testing inside each agent in progress |
| Identity cache | Lookups are reused for up to 5 minutes and dropped the moment an account file or variable changes; `CLOUDPIN_NO_CACHE=1` turns it off |

CI runs every test on Windows, macOS and Linux.

## Try it (from source)

```bash
npm ci
npm run build
node dist/cli.js init
node dist/cli.js check
```

## Design

The decisions behind cloudpin, and why, are in [DESIGN.md](DESIGN.md).

## Built with AI, openly

cloudpin is built by [Alvaro Reis](https://github.com/paureis) with Claude Code as a pair programmer.
Every behaviour is covered by tests, and every CLI integration is checked against the tool's own
documentation and the real CLI before it ships.

## License

MIT
