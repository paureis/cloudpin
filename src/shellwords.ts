import { folderCommand, loseFolder, moveFolder } from "./folder.js";
import { commandName } from "./guard.js";
import type { Invocation } from "./invocation.js";
import { assign, child, type Dialect, restoreFolder, type State, variables } from "./line-state.js";
import { tokenizePowerShell, windowsPowerShellArgv } from "./ps-tokens.js";
import { pipedValues, psAssignment } from "./ps-words.js";
import { type Arg, type Run, runner } from "./runners.js";
import { type Expansion, tokenize } from "./shell-tokens.js";
import { DYNAMIC_WORD, DYNAMIC_WORDS, UNKNOWN_VALUE } from "./types.js";
import { expandWord, isDynamic, substitute } from "./word-expansion.js";
import { forCall, unwrap, wrappedWords } from "./wrappers.js";

export type { Dialect, Invocation };
export { UNKNOWN_VALUE };

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
// Shell keywords that run the command after them; wrappers and runners are in wrappers.ts and runners.ts.
const KEYWORDS = new Set(["{", "!", "if", "then", "else", "elif", "while", "until", "do"]);
// find options whose arguments, up to ";" or "+", are a command it runs.
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

// PowerShell assignment: `$name = <value>` or `$name=<value>`.
const PS_ASSIGNMENT = /^\$([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/s;
// PowerShell environment variable: `$env:NAME = <value>` or `$env:NAME=<value>` (#86).
const PS_ENV = /^\$env:([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/is;
// Builtins that export: `export`, and `declare`/`typeset` with -x.
const EXPORTERS = new Set(["export", "declare", "typeset"]);

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
  // An assignment word's value with the variables the line set; UNKNOWN_VALUE when a part isn't known.
  const valueOf = (k: number, set: RegExpExecArray): string =>
    dynamic[k] ? (substitute(words[k]!, expansions[k] ?? [], vars)?.slice(set[1]!.length + 1) ?? UNKNOWN_VALUE) : set[2]!;
  if (state.dialect === "powershell") {
    // & and . run the command after them (about_Operators), return and throw the pipeline after them.
    if (!quoted[0] && ["&", ".", "return", "throw"].includes(words[0]?.toLowerCase() ?? "")) {
      [words, quoted, dynamic, expansions] = [words.slice(1), quoted.slice(1), dynamic.slice(1), expansions.slice(1)];
    } else {
      const set = psAssignment([words, quoted, dynamic, expansions]);
      if (set) {
        // `$x = vercel ls` runs vercel; a single literal is the value, a "..." with $( ) one unknown word.
        const [w, q, d, x] = set.value;
        if (!set.literal && w.length > 0) analyse(w, stdin, out, state, q, d, x);
        state.vars[`$${set.name}`] = !set.literal ? UNKNOWN_VALUE : d[0] ? (substitute(w[0]!, x[0] ?? [], vars) ?? UNKNOWN_VALUE) : w[0]!;
        state.lists[set.literal ? "delete" : "add"](set.name);
        return;
      }
      // An expression is not a command (`$cli x` is a parse error); its ( ) and $( ) parts were read already.
      if (!PS_ENV.test(words[0] ?? "") && dynamic[0]) return;
    }
  }
  const psEnv = PS_ENV.exec(words[0] ?? "");
  if (psEnv && (psEnv[2] !== undefined || words[1] === "=")) {
    // A single literal (`'other'`, `other`) is known; anything else (an expression,
    // a command, `(Get-Content f)`, `$x`) is only known when it runs.
    const inline = psEnv[2] !== undefined && psEnv[2] !== "";
    const from = inline ? 1 : psEnv[2] !== undefined ? 1 : 2;
    const value = inline ? psEnv[2]! : words[from];
    // Inline, the word's own `$env:` counts as an expansion, so look at the value part alone.
    const expandsValue = inline ? /\$[A-Za-z_{(]/.test(value!) : dynamic[from];
    const known = value !== undefined && words.length === (inline ? 1 : from + 1) && !expandsValue;
    assign(state, psEnv[1]!, known ? value : UNKNOWN_VALUE, true);
    return;
  }
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
  for (;;) {
    const word = words[i];
    if (word === undefined) {
      // Only assignments: they set shell variables for the rest of the line.
      for (const [name, value] of Object.entries(env)) assign(state, name, value, false);
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
    if (step.clearEnv) for (const k of Object.keys(env)) delete env[k];
    for (const k of step.unset ?? []) delete env[k];
    state = forCall(state, step, child);
    [words, quoted, dynamic, expansions] = wrappedWords([words, quoted, dynamic, expansions], step, split.map((t) => (t.kind === "word" ? t.value : "")));
    i = step.next;
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
      // A command held in a variable set elsewhere: check every guarded CLI the line names.
      // A bare `$files` is most likely a value (PowerShell pipes it), not a command.
      if (expanded.length > 1) for (const named of namedClis(state)) out.push(invocation(named, expanded.slice(1), env, state));
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
          analyse(run, stdin, out, { ...child(state), exported: { ...state.exported, ...env }, dialect: "bash" }, [], run.map(isDynamic));
        } else out.push(invocation(bin, argv, env, state));
      };
      call(expanded.slice(1));
      // Windows PowerShell 5.1 passes quotes inside an argument unescaped, and the CLI splits it again (#159).
      const legacy = state.dialect === "powershell" ? windowsPowerShellArgv(expanded.slice(1)) : [];
      if (state.dialect === "powershell" && JSON.stringify(legacy) !== JSON.stringify(expanded.slice(1))) call(legacy);
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

  if (EXPORTERS.has(name)) {
    // `declare`/`typeset` export only with -x; `export -n` un-exports (left alone: it never adds a variable).
    const flags = args.filter((a) => a.startsWith("-"));
    if (name !== "export" && !flags.some((f) => /^-[a-zA-Z]*x/.test(f))) return;
    if (flags.includes("-n")) return;
    const offset = i + 1;
    args.forEach((arg, k) => {
      if (arg.startsWith("-")) return;
      const set = ASSIGNMENT.exec(arg);
      if (set) assign(state, set[1]!, valueOf(offset + k, set), true);
      else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg) && arg in state.vars) assign(state, arg, state.vars[arg]!, true);
    });
    return;
  }
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
  // The arguments with the line's variables, for a command that runs them (#162).
  const runArgs = (): Arg[] =>
    args.map((raw, k) => {
      const at = from === -1 ? -1 : from + k;
      const x = expansions[at];
      return { raw, quoted: quoted[at] ?? false, dynamic: dynamic[at] ?? isDynamic(raw), value: isDynamic(raw) ? undefined : x ? substitute(raw, x, vars) : raw };
    });
  const run: Run | undefined = name === "eval" || name === "find" ? undefined : runner(name, runArgs(), state.dialect);
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
      runLine(text, dialect, out, env, state, run.here);
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

function invocation(bin: string, args: string[], env: Record<string, string>, state: State): Invocation {
  const inv: Invocation = { bin, args, env: { ...state.exported, ...env } };
  if (Object.keys(state.plain).length > 0) inv.ifExported = { ...state.plain };
  const unset = [...state.unset, ...(state.callUnset ?? [])];
  if (unset.length > 0) inv.unset = unset;
  if (state.cwd !== undefined) inv.cwd = state.cwd;
  if (state.clearEnv) inv.clearEnv = true;
  return inv;
}

/** Guarded CLI names that appear as whole words in `text`, the whole line by default. */
function namedClis(state: State, text = state.line): string[] {
  return [...state.guarded].filter((name) =>
    new RegExp(`(^|[^A-Za-z0-9_.-])${name.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)}([^A-Za-z0-9_.-]|$)`).test(text),
  );
}

/** Something cloudpin can't read decides what runs (#162): each guarded CLI named in `text` (or the line) can't tell. */
function cantTell(text: string, wholeLine: boolean, out: Invocation[], env: Record<string, string>, state: State): void {
  for (const name of new Set([...namedClis(state, text), ...(wholeLine ? namedClis(state) : [])])) {
    out.push(invocation(name, [DYNAMIC_WORDS], env, state));
  }
}

/** A line a runner runs, read with its shell's rules, in a child shell. */
function runLine(text: string, dialect: Dialect, out: Invocation[], env: Record<string, string>, state: State, here = false): void {
  if (isDynamic(text)) cantTell(text, true, out, env, state);
  else collect(text, out, here ? state : { ...child(state), dialect });
}

function collect(input: string, out: Invocation[], state: State): void {
  let segment: string[] = [];
  let quoted: boolean[] = [];
  let dynamic: boolean[] = [];
  let expansions: (Expansion[] | undefined)[] = [];
  let stdin: string[] = [];
  // What to go back to when a ( ) subshell ends: its `cd` and variables don't come back (#86).
  const saved: State[] = [];
  // A pipe's sides and a background job run in child shells, in bash; PowerShell only moves a job (#163).
  const end = (own = false) => {
    const before = { ...state };
    if (segment.length > 0) analyse(segment, stdin, out, state, quoted, dynamic, expansions);
    if (own) restoreFolder(state, before);
    segment = [];
    quoted = [];
    dynamic = [];
    expansions = [];
    stdin = [];
  };
  const tokens = state.dialect === "powershell" ? tokenizePowerShell(input) : tokenize(input);
  const isOp = (t: number, op: string) => tokens[t]?.kind === "op" && (tokens[t] as { op: string }).op === op;
  // `&` or `|` alone: `&&` and `||` are two of them in a row.
  const lone = (t: number, op: string) => isOp(t, op) && !isOp(t - 1, op) && !isOp(t + 1, op);
  let afterPipe = false;
  for (const [t, token] of tokens.entries()) {
    if (token.kind === "word") {
      segment.push(token.value);
      quoted.push(token.quoted);
      dynamic.push(token.dynamic);
      expansions.push(token.expansions);
    }
    else if (token.kind === "stdin") stdin.push(token.body);
    // Runs where it appears, in a child shell, so a `cd` inside does not leak. PowerShell has no child shell here: a
    // ( ) or a block moves the session's folder, if it runs at all, so what follows it can't tell (#163).
    else if (token.kind === "subst") {
      const inner = child(state);
      collect(token.inner, out, inner);
      if (state.dialect === "powershell" && (inner.cwd !== state.cwd || inner.stack !== state.stack)) loseFolder(state);
    } else {
      // PowerShell pipes values: the next command reads a literal string as its input (`'az ...' | iex`), a
      // variable's known value, and anything else as input it can't read (#162).
      const piped = token.op === "|" && state.dialect === "powershell" ? pipedValues([segment, quoted, dynamic, expansions], state) : [];
      const pipe = state.dialect === "bash" && lone(t, "|");
      end(afterPipe || pipe || lone(t, "&"));
      afterPipe = pipe;
      stdin = piped;
      if (token.op === "(") saved.push(child(state));
      else if (token.op === ")" && saved.length > 0) {
        const outer = saved.pop()!;
        restoreFolder(state, outer);
        state.vars = outer.vars;
        state.exported = outer.exported;
        state.plain = outer.plain;
        state.unset = outer.unset;
      }
    }
  }
  end(afterPipe);
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
 * PowerShell 5.1 passes it on (#159).
 */
export function findInvocations(
  command: string,
  guardedBins: string[],
  baseCwd?: string,
  env?: NodeJS.ProcessEnv,
  dialect: Dialect = "bash",
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
  });
  return out;
}
