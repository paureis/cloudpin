import { cmdRereads } from "./cmd-reread.js";
import { folderCommand, loseFolder, moveFolder } from "./folder.js";
import { commandName } from "./guard.js";
import { cantTell, invocation, looksUpCli, namedClis, nextAliases, pipedText, psValue, readAlias, readTraps, wholeExpansion, withAlias } from "./hidden-calls.js";
import type { Invocation } from "./invocation.js";
import { ASSIGNMENT, assignedValue, assignInBranch, branchTracker, carryBlock, type EnvArg, isPsEnvWord, readEnvCommand, readPsAssignment, readPsEnvWords, readSetEnvironmentVariable } from "./line-env.js";
import { assign, child, type Dialect, EXPORTERS, restoreEnv, restoreFolder, type State, variables } from "./line-state.js";
import { tokenizePowerShell, windowsPowerShellArgv } from "./ps-tokens.js";
import { pipedValues, psAssignment, type Words } from "./ps-words.js";
import { type Arg, FIND_EXEC, type Run, runner } from "./runners.js";
import { type Expansion, tokenize } from "./shell-tokens.js";
import { DYNAMIC_WORD, DYNAMIC_WORDS, UNKNOWN_VALUE } from "./types.js";
import { expandWord, isDynamic, substitute } from "./word-expansion.js";
import { forCall, unwrap, wrappedWords } from "./wrappers.js";

export type { Dialect, Invocation };
export { UNKNOWN_VALUE };

// Shell keywords that run the command after them; wrappers and runners are in wrappers.ts and runners.ts.
const KEYWORDS = new Set(["{", "!", "if", "then", "else", "elif", "while", "until", "do"]);

// PowerShell assignment: `$name = <value>` or `$name=<value>`.
const PS_ASSIGNMENT = /^\$([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/s;

function analyse(
  words: string[],
  stdin: string[],
  out: Invocation[],
  state: State,
  quoted: boolean[] = [],
  dynamic: boolean[] = [],
  expansions: (Expansion[] | undefined)[] = [],
): void {
  const vars = variables(state);
  // PowerShell's first word runs only after & (`$c` prints, `if ($c)` tests, `. $f` is a script, not read).
  let runsWord = state.dialect === "bash" && !(state.asValue && words.length === 1);
  // An assignment word's value with the variables the line set; UNKNOWN_VALUE when a part isn't known.
  const valueOf = (k: number, set: RegExpExecArray): string =>
    assignedValue({ raw: words[k]!, quoted: false, expansions: dynamic[k] ? (expansions[k] ?? []) : undefined }, set, state, vars);
  if (state.dialect === "powershell") {
    // & and . run the command after them (about_Operators), return and throw the pipeline after them.
    if (!quoted[0] && ["&", ".", "return", "throw"].includes(words[0]?.toLowerCase() ?? "")) {
      // A dot-sourced script runs here, and can set anything; a call or a block is read as what it is (#163).
      if (words[0] === "." && words[1] !== undefined && !words[1].startsWith("{") && !state.guarded.has(commandName(words[1]))) state.envUnknown = true;
      runsWord = words[0] === "&";
      [words, quoted, dynamic, expansions] = [words.slice(1), quoted.slice(1), dynamic.slice(1), expansions.slice(1)];
    } else {
      const set = psAssignment([words, quoted, dynamic, expansions]);
      if (set) {
        // `$x = vercel ls` runs vercel; a single literal is the value, a "..." with $( ) one unknown word.
        const [w, q, d, x] = set.value;
        if (!set.literal && w.length > 0) analyse(w, stdin, out, state, q, d, x);
        if ("env" in set) return readPsAssignment(set, state, vars);
        state.vars[`$${set.name}`] = !set.literal ? UNKNOWN_VALUE : d[0] ? (substitute(w[0]!, x[0] ?? [], vars) ?? UNKNOWN_VALUE) : w[0]!;
        state.lists[set.literal ? "delete" : "add"](set.name);
        return;
      }
      // An expression is not a command (`$cli x` is a parse error); its ( ) and $( ) parts were read already.
      if (!isPsEnvWord(words[0]) && dynamic[0]) return;
    }
  }
  if (readPsEnvWords(words, dynamic, state)) return;
  const ps = state.dialect === "bash" ? PS_ASSIGNMENT.exec(words[0] ?? "") : null;
  if (ps && (ps[2] !== undefined || words[1] === "=")) {
    // `$x = "vercel"` stores a string; `$x = vercel ls` runs vercel and stores its output.
    const inline = ps[2] !== undefined && ps[2] !== "";
    const rest = inline ? [ps[2]!, ...words.slice(1)] : words.slice(ps[2] !== undefined ? 1 : 2);
    const restQuoted = inline ? quoted : quoted.slice(ps[2] !== undefined ? 1 : 2);
    const restDynamic = inline ? [false, ...dynamic.slice(1)] : dynamic.slice(ps[2] !== undefined ? 1 : 2);
    const restExpansions = inline ? [undefined, ...expansions.slice(1)] : expansions.slice(ps[2] !== undefined ? 1 : 2);
    if (rest.length === 1 && restQuoted[0]) {
      state.vars[ps[1]!] = rest[0]!;
      return;
    }
    delete state.vars[ps[1]!];
    if (rest.length > 0) analyse(rest, stdin, out, state, restQuoted, restDynamic, restExpansions);
    return;
  }
  const env: Record<string, string> = {};
  let i = 0;
  let wrapper: string | undefined;
  for (;;) {
    const word = words[i];
    if (word === undefined) {
      // Only assignments: they set shell variables for the rest of the line.
      for (const [name, value] of Object.entries(env)) (state.inBranch ? assignInBranch(state, name, value) : assign(state, name, value, false));
      return;
    }
    const assignment = ASSIGNMENT.exec(word);
    if (assignment) {
      env[assignment[1]!] = valueOf(i, assignment);
      i++;
      continue;
    }
    if (KEYWORDS.has(word) && !quoted[i]) {
      i++;
      continue;
    }
    // A wrapper (env, sudo, nice, xargs, npx...) runs the command after its own flags (#162).
    const step = dynamic[i] ? undefined : unwrap(commandName(word), words, i, dynamic);
    if (!step) break;
    if (step.none) return;
    const split = step.split === undefined ? [] : tokenize(step.split);
    if (step.unknown || split.some((t) => t.kind !== "word" || t.dynamic)) {
      cantTell(words.slice(i).join(" "), dynamic.slice(i).some(Boolean), out, env, state);
      return;
    }
    if (step.script !== undefined) {
      runLine(step.script, "bash", out, env, state);
      return;
    }
    wrapper ??= word;
    if (step.clearEnv) for (const k of Object.keys(env)) delete env[k];
    for (const k of step.unset ?? []) delete env[k];
    state = forCall(state, step, child);
    [words, quoted, dynamic, expansions] = wrappedWords([words, quoted, dynamic, expansions], step, split.map((t) => (t.kind === "word" ? t.value : "")));
    i = step.next;
  }
  const alias = withAlias([words, quoted, dynamic, expansions], i, state);
  if (alias === "unknown") return cantTell("", true, out, env, state);
  if (alias) {
    const all = state.aliases!;
    state.aliases = alias.others;
    analyse(alias.words[0], stdin, out, state, alias.words[1], alias.words[2], alias.words[3]);
    state.aliases = all;
    return;
  }
  let bin = words[i]!;
  let args = words.slice(i + 1);
  // Where `args` starts in `words`, while it holds the words as typed.
  let from = i + 1;
  let name = commandName(bin);
  if (!EXPORTERS.has(name) && name !== "unset" && !folderCommand(bin, state.dialect)) {
    // The words bash passes on: the variables the line set substituted, the rest marked as known only
    // when it runs (#160).
    const expanded = words
      .slice(i)
      .flatMap((w, k) => (expansions[i + k] ? expandWord(w, expansions[i + k]!, quoted[i + k] ?? false, vars) : [w]));
    if (expanded.length === 0) return;
    if (expanded[0] === DYNAMIC_WORD || expanded[0] === DYNAMIC_WORDS) {
      // A command only known when it runs: every guarded CLI the line names can't tell (#163). With text around it, it is
      // a path to a script, and its arguments are still read as the CLI's.
      if (runsWord && wholeExpansion(words[i]!, quoted[i] ?? false, expansions[i], state) && !looksUpCli(state)) cantTell("", true, out, env, state);
      else if (expanded.length > 1) for (const named of namedClis(state)) out.push(invocation(named, expanded.slice(1), env, state));
      return;
    }
    bin = expanded[0]!;
    name = commandName(bin);
    if (state.guarded.has(name)) {
      const call = (argv: string[]) => {
        // `cloudpin exec` checks in shell mode, where CLOUDPIN_SKIP works, and starts its command without a shell,
        // so that command is read as the words it is: a CLI, `npx` or `bash -c` around one, `cloudpin switch` (#14).
        if (name === "cloudpin" && argv[0] === "exec") {
          const run = argv.slice(argv[1] === "--" ? 2 : 1);
          if (run[0] !== undefined && isDynamic(run[0])) cantTell("", true, out, env, state);
          else analyse(run, stdin, out, { ...child(state), exported: { ...state.exported, ...env }, dialect: "bash" }, [], run.map(isDynamic));
        } else out.push(invocation(bin, argv, env, state));
      };
      const reread = cmdRereads(bin, wrapper, [words, quoted, dynamic, expansions], i + 1, vars, env, out, state);
      call(expanded.slice(1));
      // Windows PowerShell 5.1 passes quotes inside an argument unescaped, and the CLI splits it again (#159).
      const legacy = state.dialect === "powershell" ? windowsPowerShellArgv(expanded.slice(1)) : [];
      if (state.dialect === "powershell" && JSON.stringify(legacy) !== JSON.stringify(expanded.slice(1))) call(legacy);
      reread?.();
      return;
    }
    // eval, shells, find and script blocks get the words as typed, which the code they run expands;
    // from a variable (`SH=bash; $SH -c ...`) they no longer line up with what was typed.
    if (dynamic[i]) [args, from] = [expanded.slice(1), -1];
  }
  // The words from `a` to `b` of `args`, with what analyse needs to expand them.
  const part = (a: number, b?: number): Parameters<typeof analyse> => {
    const end = b === undefined ? undefined : from + b;
    const slice = <T>(list: T[]) => (from === -1 ? [] : list.slice(from + a, end));
    return [args.slice(a, b), [], out, state, slice(quoted), slice(dynamic), slice(expansions)];
  };

  const envArgs = args.map((raw, k): EnvArg => {
    const at = from === -1 ? -1 : from + k;
    return { raw, quoted: quoted[at] ?? false, expansions: dynamic[at] ? (expansions[at] ?? []) : undefined };
  });
  const aliased = readAlias(name, envArgs, state, vars);
  if (aliased === "unknown") cantTell("", true, out, env, state);
  if (aliased) return;
  // The arguments with the line's variables, for a command that runs them (#162).
  const runArgs = (): Arg[] =>
    args.map((raw, k) => {
      const at = from === -1 ? -1 : from + k;
      const x = expansions[at];
      return { raw, quoted: quoted[at] ?? false, dynamic: dynamic[at] ?? isDynamic(raw), value: isDynamic(raw) ? undefined : x ? substitute(raw, x, vars) : raw };
    });
  const run: Run | undefined = name === "eval" || name === "find" ? undefined : runner(name, runArgs(), state.dialect);
  // `. <(...)` both may set anything and runs text cloudpin can't read.
  if (readEnvCommand(name, envArgs, state, vars, stdin.length > 0) && !run) return;
  if (name === "unset") {
    if (args.includes("-f")) return;
    for (const arg of args) {
      if (arg.startsWith("-")) continue;
      delete state.vars[arg];
      delete state.exported[arg];
      delete state.plain[arg];
      state.unset.add(arg);
    }
    return;
  }
  const folder = folderCommand(bin, state.dialect);
  if (folder) {
    moveFolder(state, folder, args.map((raw, k) => (from === -1 ? { raw, quoted: false } : { raw, quoted: quoted[from + k] ?? false, expansions: expansions[from + k] })), vars, env);
    return;
  }
  if (name === "eval") {
    // eval joins its arguments and runs them as a command line, in this shell.
    if (isDynamic(args.join(" "))) cantTell(args.join(" "), true, out, env, state);
    else collect(args.join(" "), out, state);
  } else if (name === "find") {
    for (let k = 0; k < args.length; k++) {
      if (!FIND_EXEC.has(args[k]!)) continue;
      const end = args.findIndex((a, j) => j > k && (a === ";" || a === "+"));
      analyse(...part(k + 1, end === -1 ? undefined : end));
    }
  } else if (run) {
    // Each line is read with the rules of the shell that runs it (#159); a shell without a script reads
    // its commands from standard input: `bash <<EOF`, `pwsh -Command - <<EOF`, `'...' | iex`.
    for (const { text, dialect } of [...(run.lines ?? []), ...(run.stdin ? stdin.map((text) => ({ text, dialect: run.stdin! })) : [])]) {
      runLine(text, dialect, out, env, run.allexport ? { ...state, allexport: true } : state, run.here);
      if (run.later) state.atExit = [...(state.atExit ?? []), text];
    }
    const started = forCall(state, run.cwd === undefined ? {} : { cwd: run.cwd }, child);
    for (const argv of run.argvs ?? []) analyse(argv, [], out, { ...child(started), dialect: "bash" });
    if (run.from !== undefined) analyse(...part(run.from));
    if (run.unknown) cantTell(args.join(" "), runArgs().some((a) => a.value === undefined), out, env, state);
  } else if (args.includes("{")) {
    // A PowerShell script block, e.g. `ForEach-Object { gh pr view $_ }`: its
    // first statement shares this segment (later ones are segments of their own).
    const open = args.indexOf("{");
    const close = args.lastIndexOf("}");
    analyse(...part(open + 1, close > open ? close : undefined));
  }
}

/** A line a runner runs, read with its shell's rules, in a child shell. */
function runLine(text: string, dialect: Dialect, out: Invocation[], env: Record<string, string>, state: State, here = false): void {
  if (isDynamic(text)) cantTell(text, true, out, env, state);
  // A new shell has none of this one's aliases.
  else collect(text, out, here ? state : { ...child(state), dialect, aliases: {}, aliasesNext: {} });
}

function collect(input: string, out: Invocation[], state: State): void {
  let segment: string[] = [];
  let quoted: boolean[] = [];
  let dynamic: boolean[] = [];
  let expansions: (Expansion[] | undefined)[] = [];
  let stdin: string[] = [];
  const branch = branchTracker(state);
  let andOr = false;
  nextAliases(state);
  state.asValue = false;
  const trapsBefore = state.atExit?.length ?? 0;
  // What to go back to when a ( ) subshell ends: its `cd` and variables don't come back (#86).
  const saved: State[] = [];
  // A pipe's sides and a background job run in child shells, in bash; PowerShell only moves a job (#163).
  const end = (own = false) => {
    const before = child(state);
    // A compound's body is read after the `;` that ends this segment, still in that child shell (`| while read X; do`).
    const compound = KEYWORDS.has(segment[0] ?? "") && !quoted[0];
    if (segment.length > 0) {
      branch(quoted[0] ? undefined : segment[0], andOr);
      analyse(segment, stdin, out, state, quoted, dynamic, expansions);
      andOr = false;
    }
    if (own) restoreFolder(state, before);
    if (own && !compound) restoreEnv(state, before);
    segment = [];
    quoted = [];
    dynamic = [];
    expansions = [];
    stdin = [];
    delete state.typed;
  };
  const tokens = state.dialect === "powershell" ? tokenizePowerShell(input) : tokenize(input);
  const isOp = (t: number, op: string) => tokens[t]?.kind === "op" && (tokens[t] as { op: string }).op === op;
  // `&` or `|` alone: `&&` and `||` are two of them in a row.
  const lone = (t: number, op: string) => isOp(t, op) && !isOp(t - 1, op) && !isOp(t + 1, op);
  let afterPipe = false;
  let fromPipe = false;
  for (const [t, token] of tokens.entries()) {
    if (token.kind === "word") {
      segment.push(token.value);
      quoted.push(token.quoted);
      dynamic.push(token.dynamic);
      expansions.push(token.expansions);
      if (token.typed !== undefined) state.typed = token.typed;
    }
    else if (token.kind === "stdin") {
      // A heredoc or a redirection wins over the pipe.
      if (fromPipe) stdin = [];
      fromPipe = false;
      stdin.push(token.body);
    }
    // Runs where it appears, in a child shell, so a `cd` inside does not leak. PowerShell has no child shell here: a
    // ( ) or a block moves the session's folder, if it runs at all, so what follows it can't tell (#163).
    else if (token.kind === "subst") {
      const powershell = state.dialect === "powershell";
      if (powershell && /::SetEnvironmentVariable$/i.test(segment.at(-1) ?? "")) readSetEnvironmentVariable(token.inner, state);
      const inner = child(state);
      collect(token.inner, out, inner);
      if (powershell && (inner.cwd !== state.cwd || inner.stack !== state.stack)) loseFolder(state);
      if (powershell) carryBlock(state, inner, segment, token.inner);
    } else {
      // PowerShell pipes values: the next command reads a literal string as its input (`'az ...' | iex`), a
      // variable's known value, and anything else as input it can't read (#162). bash pipes text (#163).
      const statement: Words = [segment, quoted, dynamic, expansions];
      const piped = state.dialect === "powershell" ? (token.op === "|" ? pipedValues(statement, state) : []) : lone(t, "|") ? pipedText(statement, stdin, variables(state)) : [];
      // `|&`, a new line or a ( right after the pipe: the next command still reads it.
      const carried = segment.length === 0 && isOp(t - 1, "|") && !isOp(t - 2, "|") && token.op !== "|";
      const passed = carried ? stdin : piped;
      const pipe = state.dialect === "bash" && (lone(t, "|") || carried);
      state.asValue = psValue(tokens, t);
      end(afterPipe || pipe || lone(t, "&"));
      if ((token.op === "&" && isOp(t - 1, "&")) || (token.op === "|" && isOp(t - 1, "|"))) andOr = true;
      state.asValue = false;
      afterPipe = pipe;
      stdin = passed;
      fromPipe = passed.length > 0;
      if (token.op === "\n") nextAliases(state);
      if (token.op === "(") saved.push(child(state));
      else if (token.op === ")" && saved.length > 0) {
        const outer = saved.pop()!;
        restoreFolder(state, outer);
        restoreEnv(state, outer);
      }
    }
  }
  end(afterPipe);
  readTraps(trapsBefore, out, state, (text, into) => runLine(text, "bash", into, {}, child(state), true));
}

/**
 * Finds every call to a guarded CLI in a shell command line, including inside
 * pipelines, lists, subshells, command substitutions, `bash -c` strings and
 * heredocs fed to a shell. With `baseCwd`, a `cd` earlier in the line sets the
 * call's `cwd` (scoped to its subshell), so `cd ../other && vercel deploy` is
 * checked against ../other's pins; where it can't be read, `cwd` is
 * UNKNOWN_FOLDER (`folder.ts`). A command held in a variable is resolved
 * from assignments earlier in the line; if it can't be, every guarded CLI the
 * line names is checked. A variable the line set is substituted; any other
 * expansion becomes DYNAMIC_WORD or DYNAMIC_WORDS, which `env` (the
 * environment the line starts in) can only narrow to one word (#160).
 * `dialect` is the shell that reads the line: a PowerShell line is read with
 * PowerShell's rules (`ps-tokens.ts`), and each call also as Windows
 * PowerShell 5.1 passes it on (#159). Text that runs and can't be read stops the
 * CLIs the line names, except one it only ever calls in ways `exempt` lets by.
 */
export function findInvocations(
  command: string,
  guardedBins: string[],
  baseCwd?: string,
  env?: NodeJS.ProcessEnv,
  dialect: Dialect = "bash",
  exempt?: State["exempt"],
  cmdFile?: State["cmdFile"],
): Invocation[] {
  const out: Invocation[] = [];
  collect(command, out, {
    base: baseCwd,
    vars: {},
    exported: {},
    plain: {},
    unset: new Set(),
    line: command,
    guarded: new Set(guardedBins),
    dialect,
    lists: new Set(),
    ...(env ? { env } : {}),
    ...(exempt ? { exempt } : {}),
    ...(cmdFile ? { cmdFile } : {}),
  });
  return out;
}
