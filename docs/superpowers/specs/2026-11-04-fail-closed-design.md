# Design note: failing closed where the parser can't follow the line (#163, #168)

Measured on `main` at 56e4792, 2026-11-04. Labels: **[M]** measured, **[S]** read from source or docs, **[I]** inferred.

## The problem

An agent hook gets a command line as text, and cloudpin must read it as the shell will. Where it reads it wrongly, the command runs with no objection.
The issue asks whether "the line mentions a CLI but no call was found" should mean "can't tell". Measured answer: no. In 57 of the 93 real silent allows the call **was** found; the folder, environment or words around it were misread.

## What happens today [M]

Each shape ran through `node dist/cli.js hook claude`, then in real Git Bash or Windows PowerShell 5.1 with argv printers named like the CLIs, to prove what really runs. 266 shapes; 18 controls all correct (10 deny, 8 pass). "ALLOW" means no objection and the printer really ran on the wrong account.

| Shape | Today | Family |
|---|---|---|
| `set -a`, `set -o allexport`, `. file`, `source file`, `local -x`, `export X+=y` | ALLOW (6 of 6) | Environment |
| `${env:X}=`, `Set-Item env:X`, `[Environment]::Set...`, `$env:X` inside `if {}` or `& {}`, `Remove-Item Env:X` | ALLOW (6 of 6) | Environment |
| `cat <<X \| bash`, `echo ... \| sh`, `trap '...' EXIT`, `${CLI:-az}`, `bash -c -e '...'` | ALLOW (5 of 5) | Hidden call |
| `f(){ az "$@"; }; f`, `bash -c 'az "$@"' _ ...`, `"$(command -v az)" ...` | deny: fixed. `alias a=az; a ...` on one line: no call, bash doesn't expand it | Hidden call |
| `cd "$(git rev-parse ...)/x"`, `cd "$D"`, `pushd`, `cd -P`, `cd --`, `Set-Location`, `sl`, `Push-Location`, `cd -Path` | ALLOW (9 of 9) | Folder |
| `$a='--subscription','x'; az $a`, `@a`, `function run { az @args }` | deny: fixed | PowerShell variables |
| NBSP and smart quotes in PowerShell, 5.1 embedded quotes | deny: fixed. NBSP in bash: no harm, no flag reaches the CLI | Characters |
| False block: `$s='pinned'; az --subscription $s` | passes: fixed | False block |
| `vercel deploy su*`, `vercel deploy {sub,}` | ALLOW (2 of 2). Other CLIs' `--profile oth*`, `--context oth*`: deny, the literal doesn't match | Words a shell rewrites |
| `vercel pull missing`, `vercel dev missing` | no objection, no harm: Vercel 50.35 stops with an error when the folder isn't one [S: `setupAndLink`] | Missing folder |
| `"cloud"pin switch`, `-EncodedCommand ...`, `a\z` | hook denies; Cursor's matcher never sends them | Cursor |
| `.cmd` re-reading (#168) | ALLOW, see below | cmd.exe |

**Worse than the list** (65 more real silent allows, all ALLOW [M]):
- `cd -- x` or `Set-Location x` with a nested pin file applies the wrong pin file, for every CLI, not only Vercel.
- `eval "$(...)"` and `sh -c "$(...)"`: the can't-tell path exists, but `$( )` leaves an empty word, so it never fires [S: `shellwords.ts`].
- `t(){ "$@"; }; t gh ...` and `for c in "cli x"; do $c; done`. Both are in the real corpus: 3 lines ran a guarded CLI this way, unseen.
- `az ... {--subscription,other}` (a brace makes the flag, on az, aws, kubectl, gcloud, vercel); `Set-Alias a az`; `. <(...)`; `x=${y:-$(az ...)}`.

Totals: 93 real silent allows, 28 of them on the issue's own list. By family: hidden 36, folder 24, environment 20, rewritten words 13.

## The options

Corpus [M]: 31,764 shell commands from 30 days of the owner's Claude Code transcripts, 12 projects (31,535 Bash, 229 PowerShell). 4,875 name a guarded CLI; 2,917 (9.2%) name one with no call found. Almost no pin file exists yet (8 lines), so counts assume every CLI is pinned; limiting to CLIs each project really calls changes them about 1%. Each rule is a prototype on the real parser; "caught" means it fired on a shape I ran.

| Option | Caught: listed / all | New stops | False in hand sample | Size [I] | Rating |
|---|---|---|---|---|---|
| 1a. Any mention | 4/28, 33/93 | 2,917 (97 a day) | 60 of 60 | ~20 lines, `shellwords.ts` | Poor |
| 1b. Unquoted mention | 0/28, 16/93 | 2,076 | 30 of 30 | ~30 | Poor |
| 1c. Unquoted, whole word is the CLI | 0/28, 14/93 | 149 (72 outside this repo) | 44 of 50 (2 true, 4 self-tests) | ~30 | Poor |
| 1d. Mention plus account flag | 0/28, 5/93 | 163 (14 outside this repo) | 30 of 30 | ~30 | Poor |
| 2. Strict allowlist grammar | 23/28, 72/93 | 3,396 (113 a day) | 30 of 30; broke the 3 false-block controls | ~200 plus a list to maintain | Poor |
| **3. Follow or refuse, by family** | **28/28, 87/93** | **8** | **3 of 8** (5 true) | ~250 src, ~200 tests | **Best** |
| 4. Keep patching top shapes | 18/28, 37/93 | 5 | 5 of 5 | ~80 | Fair |

**Option 1** [M]: its false stops are paths and filenames 1,967 (`sed -n 1,9p supabase/x.sql`), heredoc bodies 498, quoted arguments 343 (`grep "vercel" src/`), bare words 109 (`which vercel`). Only 57 corpus lines use `git commit -m`, because of the owner's commit rule, so a team using `-m` would pay more under 1a [I]. It misses by design: 0 of 20 environment, 0 of 24 folder, 0 of 13 rewritten words, because those lines have a call. It catches hidden calls only (33 of 36).

**Option 3, in plain words.** For each family, follow what can be read and refuse what can't:
- **Folder:** read `cd -P`, `cd -L`, `cd --`, `pushd`, `sl`, `chdir`, `Set-Location`, `Push-Location`, `-Path`, `-LiteralPath`, and a folder the line or the hook's environment knows. Anything else makes later non-exempt calls "can't tell". (Those forms rewritten to plain `cd` all denied through the real hook [M].) Corpus: 2 lines.
- **Environment:** read literal forms (`${env:X}=`, `Set-Item env:X v`, `export X+=y`). `. file`, `source file`, `set -a`, `read`, `export $(...)` and `$env:` inside a block make later calls "can't tell". Corpus: 0 lines.
- **Text that runs, unread:** pipe into a shell, `trap`, alias, `bash -c -e`, `${x:-cli}`, `eval`/`sh -c`/`source` of a substitution, a line's function given the CLI's name as a word, a bare `$c`. Each stops only the CLIs the line names, through the existing `cantTell`. Corpus: 6 lines.
- **Rewritten words (bash):** a brace list in a guarded call, or a glob in a word that picks the account or Vercel's folder. Corpus: 0 lines.

Files: `shellwords.ts`, `ps-words.ts`, `shell-tokens.ts` (mark a whole `$( )` word), `dynamic-args.ts`, `guard.ts` (unknown folder), one new table file. The cost of 8 took four rounds of tuning on this same corpus (93, 60, 41, 8 lines), so **expect more elsewhere** [I]. The 3 false stops: a function given CLI names as test filters, a self-test through `cloudpin exec`, text in a heredoc.

**Option 4** is honest for a threat that is a mistake, not an adversary: it follows the literal forms and refuses pipes into a shell. But 56 real silent allows stay, including `cd "$D"`, `. file` and every glob, and the list keeps growing.

## Recommendation

**Option 3 in 1.3.0; reject the mention rule.** Its cost is a false stop about every ten days, against 97 a day for 1a, and it is the only option that clears the whole list. It reuses the existing "can't tell" path and message. Leave as documented limits in THREAT_MODEL.md: a program that runs a CLI (`node -e`, `git -c alias.x='!az'`, a script written then run), names built from pieces (`& ('a'+'z')`), `for AWS_PROFILE in ...`, a substitution-fed runner nested inside a `bash -c` string, the contents of a sourced file (refused, not read), and a missing named folder (Vercel stops itself).

**After 1.3.0, a different kind of fix.** A shim folder first on PATH that sends each CLI through `cloudpin exec` sees the real arguments, environment and folder, with no parsing. A prototype stopped **93 of 93** real silent allows and passed every control [M, Git Bash and PS 5.1, printers only]. No text is read, so no false stops by construction [I]. Open: a real `.exe` shim on Windows, since a `.cmd` shim is itself re-read; how each agent's PATH gets it; absolute paths still bypass it. A 1.4.0 issue, a spike only.

## #168: cmd.exe re-reading

Measured with real PowerShell 5.1, Git Bash and cmd.exe, and printers shaped like the real `az.cmd` and npm's `vercel.cmd`. `pwsh` wasn't available for this, so 7.3+ is from its docs: Legacy passing for `.cmd` and `.bat`, "passed as raw command-line strings to cmd.exe" [S: learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_preference_variables].

- **What reaches cmd.exe unquoted:** 5.1 adds quotes only when an argument has a space outside its own quotes. So `'x&kubectl'` arrives bare and **runs kubectl, no objection**, on both printers. This corrects the issue: `'x&kubectl get pods'` has spaces, gets quoted, and does not run it. A space plus embedded quotes flips the state and does: `'a b"&kubectl get pods&"c'`. `--%` passes text as typed, so it runs too.
- **Silent wrong account:** `--subs^cription other` reaches the CLI as `--subscription other`; `%ZZP%` expanding to flags does too. Both no objection.
- **`)`:** inside the real `az.cmd`'s `IF ( )` block, `'(a)'` arrives as `(a`, and `'a)&kubectl'` runs kubectl. `!NAME!` stays literal; a newline cuts the value but runs nothing.
- **By path:** Git Bash runs the extensionless script, so no cmd.exe (Claude Code's Bash tool) [M]; a typed `az.cmd` there brings it back [M]. Claude's PowerShell tool and Copilot's `powershell` tool reach it [M for the shell, S for the tools]. Codex uses the user's shell, PowerShell by default on Windows; Cursor, Gemini and Antigravity don't name the shell, so the hook reads both ways [S: `hooks/agents.ts`; #110 still open].
- **How cloudpin learns it's a `.cmd`:** `resolveCommand` and `findOnPath` in `src/paths.ts` walk PATH with PATHEXT, without spawning; today only `exec.ts` calls them. `agents.ts` would call them with the call's own environment and test for `.cmd`/`.bat`, or a typed one [S].

**Narrowest rule (recommended):** only on Windows, read as PowerShell (or a typed `.cmd`), when the CLI resolves to `.cmd`/`.bat`: rebuild the command line as 5.1 does, then scan with cmd.exe's quote toggle. An unquoted `&`, `|`, `<`, `>`, `^`, `)` or newline, or `%NAME%` anywhere, is "can't tell". About 50 lines plus tests. **Cost** [M]: 0 of 229 PowerShell lines (only 1 guarded `.cmd` call among them, so thin evidence). If every line ran in PowerShell: 6 of 70 `.cmd`-CLI calls, all an unquoted `&` in a URL, which cmd.exe would really cut. Without the `.cmd` test it would be 509 of 3,195 calls, mostly `gh --jq` filters, which is why the test matters.

## Cursor's matcher

`src/install.ts` writes `\b(names)\b`, in plain classes, on `beforeShellExecution`. Cursor's docs: "The matcher runs against the shell command string"; regex flavour not stated; on Windows the desktop app "runs hook commands through PowerShell"; failures "fail open by default" unless `failClosed: true` [S: cursor.com/docs/agent/hooks].

| `cloudpin hook cursor`, 20 runs [M] | Median | Worst |
|---|---|---|
| Node alone (control) | 35 ms | 50 ms |
| Direct, no guarded CLI | 186 ms | 194 ms |
| Direct, guarded CLI, made-up pin (deny) | 197 ms | 213 ms |
| PowerShell + `.cmd` shim, no guarded CLI | 1,585 ms | 1,628 ms |
| PowerShell + `.cmd` shim, guarded, made-up pin (deny) | 1,618 ms | 1,682 ms |
| PowerShell alone (control) | 903 ms | 970 ms |

Today the matcher passes 7,261 of 31,764 lines (23%) [M]. Dropping it adds about 24,500 hook runs a month at this volume: about 11 hours at 1.6 s on Windows, about 1.3 hours at 186 ms [I: corpus is Claude Code, not Cursor]. **Recommendation: widen, don't drop.** Allow quote and escape characters between letters of each name, and add the encoded-command flags and `iex`. That passes 7,378 lines (+0.4%) [M]. It sends `"cloud"pin`, `a\z`, `a''z`, a backtick and `-EncodedCommand` to the hook; of 139 shapes the hook denies, misses drop from 6 to 2 (`$'\x61z'`, `a$'z'`). Names from variables still miss; document that. About 10 lines in `install.ts`; `updateCursorMatcher` already rewrites old entries. Must be checked once inside real Cursor. Leave `failClosed` off: it would block every matching line when cloudpin isn't installed.

## Build order for 1.3.0 (Thu 2026-12-03; only 1.3.0 items merge from about 11-26)

| PR | When | What |
|---|---|---|
| 1, 2 | by 11-13 | Folder, then environment: follow literal forms, refuse the rest |
| 3, 4 | by 11-20 | Text that runs, unread, with the empty `$( )` word; then the #168 rule, with `explain` |
| 5 | by 11-25 | Braces and account-picking globs; Cursor matcher; THREAT_MODEL limits; CHANGELOG |

**Next version:** the PATH shim spike (new issue), and PR 5's braces and globs if they slip (13 shapes, 0 corpus lines, so the release is still good without them). #163 closes when PR 5 lands.

## Decisions for the owner

1. Drop the mention rule in all its forms? **Yes**: 0 of 57 found-call shapes, up to 97 false stops a day.
2. Build option 3 in 1.3.0? **Yes**, one PR per family.
3. Deny or ask on the new "can't tell"? **Deny**, as every "can't tell" does today; at one false stop in ten days, a new kind of answer isn't worth it.
4. Follow a `cd "$VAR"` from the hook's environment? **Yes**. With line-set folders it cuts folder stops from 72 to 30, and skipping exempt calls cuts them to 2. Risk: the agent's shell could differ from the hook's environment [I].
5. #168: "can't tell", rather than split at `&` and check each? **Can't tell**: fewer lines, and every corpus hit was a line cmd.exe would really break.
6. Cursor: widen the matcher, not drop it? **Widen**, after one check in real Cursor.
7. Open a 1.4.0 issue for the PATH shim spike? **Yes**.

## Owner's decisions (2026-11-04)

Option 3, one PR per family. The answers to the seven above: 1 yes; 2 yes; 3 deny; 4 follow; 5 can't tell; 6 widen; 7 yes.
Also: agents ask on a CLI's own switch command (#180), and the PATH shim spike is #181 in 1.4.0.

## What I did not measure

Real CLIs (printers only, by rule). Real Cursor, Codex, Copilot, Gemini or Antigravity: every shape went through the `claude` adapter, and timing through `cursor` outside Cursor. `pwsh`. macOS or Linux shells. `vercel --cwd missing` in real Vercel. The shim on `.cmd` re-reading, or its latency against real CLIs. How often a real folder change lands on a different pin. Other people's command lines: the corpus is one owner, 99% Bash, 19% of it this repo, and option 3's prototype is not the final code.
