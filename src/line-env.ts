import { assign, type State } from "./line-state.js";
import type { PsEnvAssignment } from "./ps-words.js";
import type { Expansion } from "./shell-tokens.js";
import { DYNAMIC_WORDS, UNKNOWN_VALUE } from "./types.js";
import { expandWord, isDynamic, substitute, type Variables } from "./word-expansion.js";

/**
 * The variables a line's own commands set (#163): each spelling is followed where it can be read. What can set a
 * name cloudpin can't read (`. file`, `export $(...)`) marks the line `envUnknown`, which guard stops as "can't
 * tell" when a pin is in play; a name it can read with a value it can't is UNKNOWN_VALUE, which stops only the CLI
 * that name picks the account for. Each rule was checked against real Git Bash and Windows PowerShell 5.1 with a
 * printer named like the CLI (bash(1) SHELL BUILTIN COMMANDS; about_Environment_Provider, Set-Item, Set-Content,
 * New-Item, Remove-Item, Clear-Item). A User or Machine target of SetEnvironmentVariable is from .NET's source alone
 * (microsoft/referencesource, mscorlib/system/environment.cs: those branches only write the registry), as running one
 * would write to the registry.
 */

/** One argument as typed; `expansions` when a part of it is only known when it runs. */
export interface EnvArg {
  raw: string;
  quoted: boolean;
  expansions?: Expansion[] | undefined;
}

export const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=(.*)$/s;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What `X+=y` makes of X: what the line or the hook's environment holds, plus y. */
function appended(state: State, name: string, value: string): string {
  const before = state.unset.has(name) ? "" : name in state.vars ? state.vars[name]! : state.env ? (state.env[name] ?? "") : UNKNOWN_VALUE;
  return before === UNKNOWN_VALUE || value === UNKNOWN_VALUE ? UNKNOWN_VALUE : before + value;
}

/** The value `NAME=x` or `NAME+=x` gives NAME, with the variables the line set; UNKNOWN_VALUE when a part isn't known. */
export function assignedValue(arg: EnvArg, set: RegExpExecArray, state: State, vars: Variables): string {
  const typed = set[1]!.length + set[2]!.length + 1;
  const value = arg.expansions ? (substitute(arg.raw, arg.expansions, vars)?.slice(typed) ?? UNKNOWN_VALUE) : set[3]!;
  return set[2] ? appended(state, set[1]!, value) : value;
}

const words = (args: EnvArg[], vars: Variables): string[] =>
  args.flatMap((a) => (a.expansions ? expandWord(a.raw, a.expansions, a.quoted, vars) : [a.raw]));

// `set` runs over its flags until a word that isn't one (bash(1), set): `--` and `-` end them, and `-eo pipefail`
// takes the next word for -o. A word the shell may split could be -a, and a $( ) is read as one word, not a flag.
function readSet(list: string[], state: State): void {
  for (let k = 0; k < list.length; k++) {
    const word = list[k]!;
    if (word.includes(DYNAMIC_WORDS) || (word.startsWith("-") && isDynamic(word))) {
      state.envUnknown = true;
      return;
    }
    const flags = /^([-+])([A-Za-z]+)$/.exec(word);
    if (!flags) return;
    const on = flags[1] === "-";
    if (flags[2]!.includes("a")) state.allexport = on;
    if (flags[2]!.includes("o")) {
      const option = list[++k];
      if (option !== undefined && isDynamic(option)) state.envUnknown = true;
      if (option === "allexport") state.allexport = on;
    }
  }
}

// read's flags that take a value, attached or in the next word (bash(1), read); -a's is the name it sets.
function readRead(list: string[], state: State): void {
  const names: string[] = [];
  let k = 0;
  for (; k < list.length; k++) {
    const word = list[k]!;
    if (!word.startsWith("-") || word === "-" || isDynamic(word)) break;
    const at = word.slice(1).search(/[adinNptu]/) + 1;
    if (at === 0) continue;
    const attached = at < word.length - 1;
    const value = attached ? word.slice(at + 1) : list[++k];
    if (word[at] === "a" && value !== undefined) names.push(value);
  }
  for (const name of [...names, ...list.slice(k)]) {
    if (isDynamic(name)) state.envUnknown = true;
    else if (NAME.test(name)) assign(state, name, UNKNOWN_VALUE, false);
  }
}

const DECLARES = new Set(["export", "declare", "typeset"]);
const BASH_DECLARES = new Set(["local", "readonly"]);

/** export, declare, typeset, local and readonly: what each word sets, exports or takes back. */
function readDeclaration(name: string, args: EnvArg[], state: State, vars: Variables): void {
  const isFlag = (a: EnvArg) => !a.expansions && /^[-+]/.test(a.raw);
  const flags = args.filter(isFlag).map((a) => a.raw);
  // -p prints, -f and -F are about functions, and readonly has no -x: it fails and sets nothing.
  if (flags.some((f) => /^-[a-zA-Z]*[pfF]/.test(f)) || (name === "readonly" && flags.some((f) => f.includes("x")))) return;
  const exporting = name === "export" || flags.some((f) => /^-[a-zA-Z]*x/.test(f));
  const taking = name === "export" ? flags.some((f) => /^-[a-zA-Z]*n/.test(f)) : flags.some((f) => /^\+[a-zA-Z]*x/.test(f));
  const set = (key: string, value: string) => {
    if (taking) return takeExport(state, key);
    assign(state, key, value, exporting);
    if (name === "local") state.locals = [...(state.locals ?? []), key];
  };
  const bare = (key: string) => {
    if (!NAME.test(key)) return;
    if (taking) takeExport(state, key);
    else if (exporting && key in state.vars) assign(state, key, state.vars[key]!, true);
    else if (exporting) {
      state.marked = [...(state.marked ?? []), key];
      state.callUnset = state.callUnset?.filter((n) => n !== key);
    }
  };
  for (const arg of args) {
    if (isFlag(arg)) continue;
    const literal = ASSIGNMENT.exec(arg.raw);
    if (literal) set(literal[1]!, assignedValue(arg, literal, state, vars));
    else if (!arg.expansions && !isDynamic(arg.raw)) bare(arg.raw);
    else {
      for (const word of words([arg], vars)) {
        const expanded = ASSIGNMENT.exec(word);
        if (isDynamic(word)) state.envUnknown = true;
        else if (expanded) set(expanded[1]!, expanded[2] ? appended(state, expanded[1]!, expanded[3]!) : expanded[3]!);
        else bare(word);
      }
    }
  }
}

/** `export -n X`: the shell keeps X, the commands it runs no longer get it. */
function takeExport(state: State, name: string): void {
  delete state.exported[name];
  delete state.plain[name];
  state.marked = state.marked?.filter((n) => n !== name);
  state.callUnset = [...(state.callUnset ?? []), name];
}

// What a line's `}` ends may be the function a `local` was in, which is read where it is written: from here on the
// name holds what it held before, if the function ran at all.
function endBlock(state: State): void {
  for (const name of state.locals ?? []) assign(state, name, UNKNOWN_VALUE, false);
  delete state.locals;
}

type Item = "set" | "content" | "new" | "remove" | "move";
// Add-Content, Clear-Content and Move-Item fail on env: in 5.1, so they leave the variable as it was.
const PS_ITEMS = new Map<string, Item>([
  ["set-item", "set"], ["si", "set"],
  ["set-content", "content"], ["sc", "content"],
  ["new-item", "new"], ["ni", "new"],
  ["remove-item", "remove"], ["ri", "remove"], ["rm", "remove"], ["del", "remove"], ["erase", "remove"], ["rd", "remove"], ["rmdir", "remove"],
  ["clear-item", "remove"], ["cli", "remove"],
  ["rename-item", "move"], ["rni", "move"], ["ren", "move"], ["copy-item", "move"], ["cpi", "move"], ["cp", "move"], ["copy", "move"],
]);
const ENV_PATH = /(^|,)\s*env:/i;
const ENV_NAME = /^env:[\\/]*(.*)$/is;
const PS_NAME = /^[\w.-]+$/;
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether PowerShell's environment holds `name`, which it spells any way. */
function psHas(state: State, name: string): boolean {
  if ([...state.unset].some((k) => sameName(k, name))) return false;
  return [...Object.keys(state.exported), ...Object.keys(state.env ?? {})].some((k) => sameName(k, name));
}

/** The variable is gone from here on: Remove-Item, and any set to nothing, in any spelling of its name. */
function psRemove(state: State, name: string): void {
  for (const key of new Set([name, ...Object.keys(state.exported), ...Object.keys(state.env ?? {})])) {
    if (!sameName(key, name)) continue;
    delete state.vars[key];
    delete state.exported[key];
    delete state.plain[key];
    state.unset.add(key);
  }
}

/** Sets a PowerShell environment variable: undefined is a value only known when it runs, "" removes it. */
export function psSet(state: State, name: string, value: string | undefined): void {
  if (value === "") psRemove(state, name);
  else assign(state, name, value ?? UNKNOWN_VALUE, true);
}

const isNull = (raw: string) => /^\$null$/i.test(raw);

/** `$env:X = ...`, `${env:X} += ...`, `[string]$env:X = ...`, as `ps-words.ts` reads them. */
export function readPsAssignment({ env, operator, value: [w, , d, x] }: PsEnvAssignment, state: State, vars: Variables): void {
  const one = w.length === 1 && !w[0]!.includes(",") ? (isNull(w[0]!) ? "" : d[0] ? substitute(w[0]!, x[0] ?? [], vars) : w[0]!) : undefined;
  if (operator === "=") return psSet(state, env, one);
  if (operator !== "+=" || one === undefined) return psSet(state, env, undefined);
  const spelled = (from: object) => Object.entries(from).find(([k]) => sameName(k, env))?.[1] as string | undefined;
  const removed = [...state.unset].some((k) => sameName(k, env));
  const before = spelled(state.exported) ?? (removed ? "" : state.env ? (spelled(state.env) ?? "") : UNKNOWN_VALUE);
  psSet(state, env, before === UNKNOWN_VALUE ? undefined : before + one);
}

/** Set-Item and the like on an `env:` path. A path it can't say is env: is another file: most of them are. */
function readPsItem(item: Item, args: EnvArg[], state: State, vars: Variables, piped: boolean): void {
  if (item === "move") {
    if (args.some((a) => ENV_PATH.test(a.raw))) state.envUnknown = true;
    return;
  }
  let path: EnvArg | undefined;
  let value: EnvArg | undefined;
  let named: EnvArg | undefined;
  let force = false;
  let other = false;
  const rest: EnvArg[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]!;
    const flag = arg.quoted ? null : /^-([A-Za-z]+)(?::(.*))?$/s.exec(arg.raw);
    if (!flag) {
      rest.push(arg);
      continue;
    }
    const key = flag[1]!.toLowerCase();
    const inline = flag[2];
    const given = (): EnvArg | undefined => {
      if (inline === undefined) return args[++k];
      const cut = arg.raw.length - inline.length;
      return { raw: inline, quoted: false, expansions: arg.expansions?.map((e) => ({ ...e, at: e.at - cut })) };
    };
    if (["path", "literalpath", "lp", "pspath"].includes(key)) path = given();
    else if (key === "value" && inline === undefined) value = given();
    else if (key === "name") named = given();
    else if (key === "force" && inline === undefined) force = true;
    else if (key === "erroraction" || key === "ea") given();
    else other = true;
  }
  path ??= rest.shift();
  if (!path) return;
  const positional = rest.shift();
  if (positional && (item === "set" || item === "content") && !value) value = positional;
  else if (positional && ENV_PATH.test(positional.raw)) state.envUnknown = true;
  else if (positional) other = true;
  // More words than it takes: the shell's error leaves the variable, but cloudpin needn't know how.
  if (rest.length > 0) other = true;
  const text = path.expansions ? substitute(path.raw, path.expansions, vars) : path.raw;
  if (!ENV_PATH.test(text ?? path.raw)) return;
  const pathName = text === undefined ? null : ENV_NAME.exec(text);
  const name = pathName?.[1] || named?.raw;
  if (!name || !PS_NAME.test(name)) {
    state.envUnknown = true;
    return;
  }
  if (item === "remove") return other ? psSet(state, name, undefined) : psSet(state, name, "");
  if (!value) {
    // Set-Item with no value and no input empties it; Set-Content and New-Item would prompt or make an empty one.
    return psSet(state, name, item === "set" && !piped && !other ? "" : undefined);
  }
  if (other) return psSet(state, name, undefined);
  const read = isNull(value.raw) ? "" : value.expansions ? substitute(value.raw, value.expansions, vars) : !value.quoted && value.raw.includes(",") ? undefined : value.raw;
  // On a variable that exists New-Item fails, unless forced.
  if (item === "new" && !force && psHas(state, name)) return;
  psSet(state, name, read);
}

/** The arguments of `::SetEnvironmentVariable(...)`, split at the commas outside quotes and brackets. */
function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let part = "";
  let quote = "";
  let depth = 0;
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === "," && !quote && depth === 0) {
      parts.push(part);
      part = "";
    } else part += c;
  }
  return [...parts, part];
}

/** One literal argument, or undefined: '...', "..." with nothing to expand, $null, a number, `[Enum]::Name`. */
function literalArgument(typed: string): string | undefined {
  const text = typed.trim();
  if (/^'([^']|'')*'$/.test(text)) return text.slice(1, -1).split("''").join("'");
  if (/^"[^"`$]*"$/.test(text)) return text.slice(1, -1);
  if (isNull(text)) return "";
  if (/^\d+$/.test(text)) return text;
  return /^\[[\w.]+\]::(\w+)$/.exec(text)?.[1];
}

/** `[Environment]::SetEnvironmentVariable(name, value[, target])`: only Process (or none) reaches later calls. */
export function readSetEnvironmentVariable(text: string, state: State): void {
  const [name, value, target] = splitArguments(text);
  const where = target === undefined ? "process" : literalArgument(target)?.toLowerCase();
  if (where === "user" || where === "machine" || where === "1" || where === "2") return;
  const key = name === undefined ? undefined : literalArgument(name);
  if (!key) {
    state.envUnknown = true;
    return;
  }
  psSet(state, key, where === "process" || where === "0" ? (value === undefined ? undefined : literalArgument(value)) : undefined);
}

/**
 * A PowerShell ( ), $( ), @( ) or { } is not a child shell, and may or may not run: what it set can't tell. A plain
 * variable stays in a scope of its own when the block is called with & or is a function's (about_Scopes), and in
 * `foreach ($x in ...)` the loop sets $x. `words` are the statement's so far, `text` the block's.
 */
export function carryBlock(state: State, inner: State, words: readonly string[], text: string): void {
  if (inner.envUnknown) state.envUnknown = true;
  for (const name of new Set([...Object.keys(inner.exported), ...Object.keys(state.exported), ...inner.unset])) {
    if (inner.exported[name] !== state.exported[name] || (inner.unset.has(name) && !state.unset.has(name))) assign(state, name, UNKNOWN_VALUE, true);
  }
  const first = words[0]?.toLowerCase() ?? "";
  if (["&", "function", "filter"].includes(first)) return;
  const loop = first === "foreach" ? /^\s*(\$\w+)\s/.exec(text)?.[1]?.toLowerCase() : undefined;
  for (const key of Object.keys(inner.vars)) {
    if (key.startsWith("$") && inner.vars[key] !== state.vars[key]) state.vars[key] = UNKNOWN_VALUE;
  }
  if (loop) state.vars[loop] = UNKNOWN_VALUE;
  for (const name of inner.lists) state.lists.add(name);
  if (inner.aliases) state.aliases = inner.aliases;
}

/** Applies a command that changes the line's variables; false when `name` isn't one. */
export function readEnvCommand(name: string, args: EnvArg[], state: State, vars: Variables, piped: boolean): boolean {
  if (DECLARES.has(name)) readDeclaration(name, args, state, vars);
  else if (state.dialect === "powershell") {
    const item = PS_ITEMS.get(name);
    if (!item) return false;
    readPsItem(item, args, state, vars, piped);
  } else if (BASH_DECLARES.has(name)) readDeclaration(name, args, state, vars);
  else if (name === "set") readSet(words(args, vars), state);
  else if (name === "read") readRead(words(args, vars), state);
  else if (name === "source" || name === ".") {
    if (args.length > 0) state.envUnknown = true;
  } else if (name === "}") endBlock(state);
  else return false;
  return true;
}

// PowerShell environment variable: `$env:NAME = <value>` or `$env:NAME=<value>` (#86).
const PS_ENV = /^\$(?:env:([A-Za-z_][A-Za-z0-9_]*)|\{env:([A-Za-z_][A-Za-z0-9_]*)\})(?:=(.*))?$/is;
export const isPsEnvWord = (word: string | undefined): boolean => PS_ENV.test(word ?? "");

/**
 * A plain `NAME=value`, which may not run: from here on NAME is unknown, unless it already holds that value (`export` and
 * `cd` in a branch stay read as if they ran). Real bash ran `s=a; false && s=b` with `a`.
 */
export function assignInBranch(state: State, name: string, value: string): void {
  if (state.vars[name] === value) return;
  const oneWord = [value, state.vars[name] ?? ""].every((v) => !/\s/.test(v) && !v.startsWith("-"));
  assign(state, name, UNKNOWN_VALUE, false);
  if (oneWord) (state.oneWords ??= new Set()).add(name);
}

/** Tracks, statement by statement, whether a bash statement may not run. */
export function branchTracker(state: State): (head: string | undefined, andOr: boolean) => void {
  let open = 0;
  return (head, andOr) => {
    if (state.dialect !== "bash") return;
    if (/^(if|while|until|for|case)$/.test(head ?? "")) open++;
    else if (/^(fi|done|esac)$/.test(head ?? "")) open--;
    state.inBranch = open > 0 || andOr;
  };
}

/** The whole statement is `$env:X=value` or `$env:X = value`, as a line read as bash has it: sets X. */
export function readPsEnvWords(words: string[], dynamic: boolean[], state: State): boolean {
  const psEnv = PS_ENV.exec(words[0] ?? "");
  if (psEnv && (psEnv[3] !== undefined || words[1] === "=")) {
    // A single literal (`'other'`, `other`) is known; anything else (an expression,
    // a command, `(Get-Content f)`, `$x`) is only known when it runs.
    const inline = psEnv[3] !== undefined && psEnv[3] !== "";
    const from = inline ? 1 : psEnv[3] !== undefined ? 1 : 2;
    const value = inline ? psEnv[3]! : words[from];
    // Inline, the word's own `$env:` counts as an expansion, so look at the value part alone.
    const expandsValue = inline ? /\$[A-Za-z_{(]/.test(value!) || isDynamic(value!) : dynamic[from];
    const known = value !== undefined && words.length === (inline ? 1 : from + 1) && !expandsValue;
    assign(state, psEnv[1] ?? psEnv[2]!, known ? value : UNKNOWN_VALUE, true);
    return true;
  }
  return false;
}
