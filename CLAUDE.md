# cloudpin — project rules

A CLI that pins cloud accounts (az, aws, gcloud, vercel, gh, kubectl, helm) to a repo via a .cloudpin.yml file and blocks
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

- Incremental installs on Windows drop the platform-specific optional packages from the lockfile
  (rolldown, lightningcss), which breaks `npm ci` and CI on macOS/Linux. After adding or removing any dependency:
  delete `./node_modules` and `./package-lock.json`, run `socket npm install`, then confirm
  `grep -c '"node_modules/@rolldown/binding-' package-lock.json` is about 15 and `npm ci` succeeds.
- TypeScript 7 does not load `@types/node` by default; `tsconfig.json` lists `"types": ["node"]`.
- Keep runtime dependencies minimal (currently `yaml`, `cross-spawn`). Every dependency runs inside
  people's shell wrappers and agent hooks.

## Architecture

The source layout is the table in `AGENTS.md`. `src/exec.ts` is the only place that spawns processes.

## Rules for provider code

1. **Test first, using a fake `Exec`** (see `test/github.test.ts`). No test spawns a real CLI. Temporary
   folders come from `tempDir()` in `test/tmp.ts`, which deletes them; a bare `mkdtempSync` leaks one per run.
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
- **One branch per issue** (owner decision, 2026-10-08), e.g. `feat/12-environments`, `fix/7-heredocs`,
  `docs/...`, cut from an up-to-date `main` in this folder (no worktree). Run typecheck and tests locally,
  push the branch once when the issue is done (every push to an open PR costs a CI run), open a PR whose body
  says `Closes #N`, and squash-merge it when the `check` job is green (`gh pr checks`). Free private repos
  can't enforce branch protection, so this is a habit until go-public (#8), then turn protection on (it also
  helps #20). `main` stays releasable: half-done work waits on its branch.
- **CI budget** (owner rule): PRs run one Linux job (`ci.yml`); Windows and the newest Node run nightly only
  when `main` changed (`nightly.yml`; run it by hand before a release); no macOS. Read
  `node scripts/ci-minutes.mjs` at every session close (1,348 billed minutes on 2026-10-08, 76% macOS).
- Switching branches never changes the owner's installed cloudpin; only `node scripts/dogfood.mjs install` does.
- Before any `gh` call that writes, confirm `gh auth status --active` shows `paureis`.
- **Releasing needs the owner:** bump the version and CHANGELOG, tag, then run `npm publish --access public
  --auth-type=web` in the Terminal panel (the Bash tool is non-interactive, so npm exits); the owner approves in the
  browser, then approves again under npmjs.com > Staged Packages (staged publishing holds every version).

## Machine notes (owner's Windows PC)

- Installed normally: az 2.86, aws 2.34, vercel 50.35, gh 2.88, codex, Cursor (editor).
- **Test-only tools live in `~/.cloudpin-testbed` and must never go on the owner's PATH or touch
  their real configs** (owner rule): gcloud is at `.cloudpin-testbed/google-cloud-sdk/bin`. Prepend it to PATH
  inside the test command only, with a throwaway config dir (`CLOUDSDK_CONFIG="$(mktemp -d)"`). Install further
  test CLIs there with `npm install --prefix`, never globally; no PowerShell 7, no Cursor CLI.
- Before running a real agent or CLI in a test, copy its user config and diff it afterwards: `codex exec -c`
  saved a one-run trust override into `~/.codex/config.toml`.
- `.gitattributes` forces LF; edit files with the Edit tool rather than CRLF-sensitive sed.
