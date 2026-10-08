# cloudpin — project rules

A CLI that pins cloud accounts (az, aws, gcloud, vercel, gh) to a repo via `.cloudpin.yml` and blocks
commands, from a human or an AI agent, that would run on a different account. **Read `DESIGN.md` first**
(every product decision and why), then `HANDOFF.md` (where the last session stopped).

Owner: Alvaro Reis (`paureis`). The repo is private until the go-public checklist in DESIGN.md is complete.
Do not make it public, publish to npm or post anywhere without the owner's explicit yes.

## Commands

| Task | Command |
|---|---|
| Install from lockfile | `npm ci` |
| Tests | `npm test` (vitest) |
| Typecheck | `npm run typecheck` |
| Build to `dist/` | `npm run build` |
| Real-account smoke test | `npm run build` then `node scripts/smoke.mjs [provider...]` |

Run typecheck and tests as separate calls, and read each exit code; a pipe (`| grep`) hides it.

## Dependencies (bitten twice on day one)

- Add packages with `socket npm install <pkg>`, never bare `npm install`.
- Incremental installs on Windows drop the platform-specific optional packages from the lockfile
  (rolldown, lightningcss), which breaks `npm ci` and CI on macOS/Linux. After adding or removing any dependency:
  delete `./node_modules` and `./package-lock.json`, run `socket npm install`, then confirm
  `grep -c '"node_modules/@rolldown/binding-' package-lock.json` is about 15 and `npm ci` succeeds.
- TypeScript 7 does not load `@types/node` by default; `tsconfig.json` lists `"types": ["node"]`.
- Keep runtime dependencies minimal (currently `yaml`, `cross-spawn`). Every dependency runs inside
  people's shell wrappers and agent hooks.

## Architecture

- `src/config.ts`: parses and finds `.cloudpin.yml` (YAML failsafe schema, so every value is a string).
- `src/types.ts`: `ProviderDef` is the interface every CLI implements: `isExempt`, `resolve`, `compare`, `switchHint`.
- `src/providers/<name>.ts`: one file per CLI. Done: `github`, `azure`, `aws`, `gcloud`. To do: `vercel`.
- `src/guard.ts`: allow/block decision; `src/format.ts`: messages; `src/shellwords.ts`: finds CLI calls in a
  command line; `src/hooks/<agent>.ts`: agent hooks; `src/init.ts`: writes `.cloudpin.yml`; `src/cli.ts`: entry.
- `src/exec.ts`: the only place that spawns processes (`realExec`).
- `src/args.ts`: flag parsing shared by providers.

## Rules for provider code

1. **Test first, using a fake `Exec`** (see `test/github.test.ts`). No test spawns a real CLI.
2. **Check every CLI behaviour against the official docs or `<cli> --help` before coding it** (flags,
   env vars, precedence, exit codes, output fields) and cite the source in a comment where it isn't obvious.
   Recorded findings go in HANDOFF.md under "Provider research".
3. **Resolve the identity the specific command will use**, not the CLI's default: flags (`--subscription`,
   `--profile`, `--scope`, `--team`, `--project`, `--hostname`) beat env vars, which beat config files.
   Pass the command's own `env` to the CLI so token env vars count.
4. **Pin and compare stable IDs**, case-insensitive only where the provider is (GUIDs, GitHub logins).
5. **Never print, log, cache or put in an error message a token or a credential value.** Messages name
   env vars, never their values. Never run `aws configure list` (it prints key tails) or anything with `--show-token`.
6. **Never spawn with `shell: true`**; use `realExec` (cross-spawn escapes Windows `.cmd` shims).
7. **Real-account smoke test with a control** for every provider that is installed here: the active
   identity must pass and a wrong pin must fail (`scripts/smoke.mjs`). A check that cannot fail proves nothing.
   Real-account tests run **read-only commands only** (list, show, whoami, GraphQL queries): never send a
   request body, `-X POST/PATCH/DELETE`, deploy or set anything on the owner's real accounts (2026-10-08: a
   stdin test turned `gh api user` into a PATCH; GitHub rejected it, but it should never have been sent).
8. Login, logout, switch, whoami, version and help commands are always exempt (`isExempt`).

## Commits

- Small commits, one concern each. Write the message to a file and use `git commit -F <file>`
  (never inline `-m` with quotes or backticks). End with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Push to `origin main` after each green commit, so the next session starts from GitHub.
- Before any `gh` call that writes, confirm `gh auth status --active` shows `paureis`.

## Machine notes (owner's Windows 11 PC)

- Installed normally: az 2.86, aws 2.34, vercel 50.35, gh 2.88, codex, Cursor (editor).
- **Test-only tools live in `~\.cloudpin-testbed` and must never go on the owner's PATH or touch
  their real configs** (owner rule): gcloud is at `.cloudpin-testbed/google-cloud-sdk/bin`. Use them by
  prepending to PATH inside the test command only (in Git Bash write `/c/Users/...`, since a `C:` entry splits
  PATH) together with a throwaway config dir (`CLOUDSDK_CONFIG="$(mktemp -d)"`). Install further test CLIs
  there with `npm install --prefix`, never globally; no PowerShell 7, no Cursor CLI.
- `.gitattributes` forces LF; edit files with the Edit tool rather than CRLF-sensitive sed.
