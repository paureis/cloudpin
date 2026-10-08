# Contributing to cloudpin

Thanks for helping. Bug reports, new CLIs and fixes are all welcome.

## Setup

```sh
git clone https://github.com/paureis/cloudpin.git
cd cloudpin
npm ci
npm run build
npm test
```

Node.js 22 or later. CI runs the tests on Windows, macOS and Linux with Node 22 and 24.

## Ground rules

cloudpin sits in front of commands that touch real cloud accounts, so a few rules are firm:

1. **Never weaken the default.** When cloudpin cannot tell which account a command would use, it blocks and
   explains why. Changes that let a command through on uncertainty will not be merged.
2. **Never print, log or cache a credential.** Messages may name an environment variable, never its value.
3. **Never spawn through a shell.** Use `realExec` in `src/exec.ts`.
4. **Check CLI behaviour against its documentation or `--help`**, and say where it came from in a comment when
   it isn't obvious. If you observed it instead, say what you ran.
5. **Tests first.** Provider tests use a fake `Exec` (see `test/github.test.ts`); no test spawns a real CLI.

## Adding a CLI

1. Add its pin section to `src/config.ts`.
2. Implement `ProviderDef` in `src/providers/<name>.ts`: `isExempt`, `resolve`, `compare`, `switchHint`,
   `statusCommand` and `cacheInputs`.
3. Register it in `src/providers/index.ts` and add tests in `test/<name>.test.ts`.
4. If you have the CLI, try it for real: `npm run build && node scripts/smoke.mjs <name>`. Use read-only commands.

`resolve` must return the identity *the specific command* would use, so flags such as `--profile` and
environment variables count. `cacheInputs` must list every variable and file that can change that identity.

## Pull requests

- Keep each pull request to one change, with tests.
- Run `npm run typecheck` and `npm test` before pushing.
- Add a line to `CHANGELOG.md` under "Unreleased".

## Reporting a bug

Open an [issue](https://github.com/paureis/cloudpin/issues/new/choose) with the command, what you expected, and
what happened. Redact account IDs if you prefer; never paste tokens. For security problems, see
[SECURITY.md](SECURITY.md).
