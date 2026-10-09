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

Node.js 22 or later. Pull requests run the tests on Linux with Node 22; Windows and Node 24 run nightly.

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

### First, find out how the CLI picks its account

Answer these from the CLI's docs, `--help` or source before writing code, and link the answers in your pull request.
`src/providers/supabase.ts` and `src/providers/cloudflare.ts` show what that looks like.

1. **Which account or project does a command act on**, and in what order do flags, environment variables, files in
   the project folder and files in the home folder decide it? Watch for surprises: in Wrangler, `account_id` in the
   config file beats `CLOUDFLARE_ACCOUNT_ID`.
2. **Which token variables replace the stored login** (like `GH_TOKEN` for `gh`)?
3. **Is there a read-only command that names the account**, ideally with JSON output? What does it print, and with
   which exit code, when you are logged out or the token is bad?
4. **Which commands never touch the account** (login, logout, help, version, a local emulator or dev server, local
   files), and which flags switch a command between local and remote?
5. **Which commands only read**, so they can run on a protected environment without asking? Keep that list short:
   anything not on it asks, so a mistake can only make cloudpin too careful.

What to pin: a stable ID (subscription ID, account ID, project ref), never a display name.

### Then build it

1. Its pin section in `src/config.ts` (`Pins` and `SCHEMA`), and in `src/init.ts` (`PIN_FIELDS`).
2. `src/providers/<name>.ts` implementing `ProviderDef`: `isExempt`, `resolve`, `compare`, `switchHint`,
   `statusCommand` and `cacheInputs`. Register it in `src/providers/index.ts`.
3. Its read-only rules in `src/readonly.ts` (TypeScript will tell you the entry is missing).
4. Tests first, in `test/<name>.test.ts`: a fake `Exec` (see `test/github.test.ts`) and `tempDir()` from
   `test/tmp.ts` for folders. Cover each source of the account and their order, logged out, a bad token (named,
   never printed), "can't tell" (which must stop the command), exempt and read-only commands.
5. Break your own code on purpose (swap two sources, drop a check) and make sure a test fails each time.
6. If you have the CLI, try it for real: `npm run build && node scripts/smoke.mjs <name>`, with **read-only commands
   only**. The active account must pass and a wrong pin must fail.
7. Docs: the README's CLI table (and a paragraph if the CLI has a twist), and a CHANGELOG entry under Unreleased.

`resolve` must return the identity *the specific command* would use, so flags such as `--profile` and
environment variables count. When it can't tell, it returns an error, and cloudpin stops the command with that
reason. `cacheInputs` must list every variable and file that can change the answer of a CLI call that `resolve` makes.

## Pull requests

- Keep each pull request to one change, with tests.
- Run `npm run typecheck` and `npm test` before pushing.
- Add a line to `CHANGELOG.md` under "Unreleased".

## Reporting a bug

Open an [issue](https://github.com/paureis/cloudpin/issues/new/choose) with the command, what you expected, and
what happened. Redact account IDs if you prefer; never paste tokens. For security problems, see
[SECURITY.md](SECURITY.md).
