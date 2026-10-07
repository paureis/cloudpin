# cloudpin

**A seatbelt for your cloud CLIs.** cloudpin stops you, or your AI coding agent, from running a command on
the wrong cloud account.

> Status: early development, not released yet. Azure, AWS and GitHub work and are tested against real
> accounts; Vercel and Google Cloud are next. See [What works today](#what-works-today).

## The problem

`az`, `aws`, `gcloud`, `vercel` and `gh` quietly act on whichever account you logged into last. With a work
account and a personal one (or two clients) on the same machine, sooner or later you deploy to, or delete
from, the wrong place. AI agents make this more likely: they run these commands for you and never stop to ask
which account is active.

## How it works

Commit a small file to your project saying which accounts it uses:

```yaml
# .cloudpin.yml
azure:
  subscription: 3f2a0000-0000-0000-0000-000000000c91   # "Acme Prod"
  tenant: 8b1d0000-0000-0000-0000-00000000044e
aws:
  account: "123456789012"
github:
  user: acme-bot
```

Before a cloud command runs, cloudpin asks the CLI who it is logged in as, the same way that command would
(honouring flags like `--subscription` and `--profile` and variables like `AWS_PROFILE` and `GH_TOKEN`), and
compares the answer with the file:

- **Match:** the command runs, and you don't notice anything.
- **Mismatch:** the command is stopped:

```text
cloudpin: blocked `gh pr merge 42`
  github is pinned in /code/acme/.cloudpin.yml
  - user: expected "acme-bot", active is "my-personal"
  fix: gh auth switch --user acme-bot
```

cloudpin only *reads* which account is active. It never logs in, never stores or prints credentials, and
always lets you run login and account-switching commands.

## What works today

| | Status |
|---|---|
| Azure (`az`) | Working, tested on a real account |
| AWS (`aws`) | Working, tested on a real account |
| GitHub (`gh`) | Working, tested on a real account |
| Vercel, Google Cloud | Next |
| `cloudpin check` (scripts, CI) | Working |
| `cloudpin exec -- <command>` | Working |
| Claude Code hook | Working, not yet installable with one command |
| Shell wrappers (bash, zsh, PowerShell) | Planned |
| Cursor, Codex, Gemini CLI, Copilot CLI hooks | Planned |
| `cloudpin init` | Planned |

## Try it (from source)

```bash
npm ci
npm run build
node dist/cli.js check
node dist/cli.js exec -- gh pr list
```

Exit codes: `0` ok, `1` usage error or failed check, `3` command blocked.

## Design

The decisions behind cloudpin, and why, are in [DESIGN.md](DESIGN.md).

## Built with AI, openly

cloudpin is built by [Alvaro Reis](https://github.com/paureis) with Claude Code as a pair programmer.
Every behaviour is covered by tests, and every CLI integration is checked against the tool's own
documentation and a real account before it ships.

## License

MIT
