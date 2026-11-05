import { commandName } from "./guard.js";
import type { Invocation } from "./invocation.js";
import type { EnvArg } from "./line-env.js";
import type { State } from "./line-state.js";
import type { Words } from "./ps-words.js";
import { type Token, tokenize } from "./shell-tokens.js";
import { DYNAMIC_WORDS, UNKNOWN_FOLDER } from "./types.js";
import { substitute, type Variables } from "./word-expansion.js";

/**
 * Text that runs, unread (#163): what a pipe hands a shell, an alias. What can be read is read; for the rest a guarded
 * CLI the line names is "can't tell", and a line that names none can't name one, so `curl ... | bash` passes. Each rule
 * was checked against real Git Bash and Windows PowerShell 5.1 with a printer named like the CLI (bash(1), ALIASES and
 * Pipelines; Set-Alias, New-Alias and about_Scopes in the PowerShell docs).
 */

export function invocation(bin: string, args: string[], env: Record<string, string>, state: State): Invocation {
  const inv: Invocation = { bin, args, env: { ...state.exported, ...env } };
  // `env -i` leaves only what its own line gives the call.
  if (state.envUnknown && !state.clearEnv) inv.envUnknown = true;
  if (Object.keys(state.plain).length > 0) inv.ifExported = { ...state.plain };
  const unset = [...state.unset, ...(state.callUnset ?? [])];
  if (unset.length > 0) inv.unset = unset;
  if (state.cwd !== undefined) inv.cwd = state.cwd;
  if (state.cwd === UNKNOWN_FOLDER && state.known !== undefined) inv.knownCwd = state.known;
  if (state.clearEnv) inv.clearEnv = true;
  return inv;
}

/** `name` as a whole word, or as what `${CLI:-name}` falls back on. */
const mention = (name: string, flags = "") =>
  new RegExp(`(?<=^|[^A-Za-z0-9_.-]|\\$\\{\\w+:?[-=+?])${name.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)}(?=[^A-Za-z0-9_.-]|$)`, flags);
// Where the words of a command named in text end, for a look at them.
const END_OF_CALL = /\d*[<>]|[;&|\n)}"'`\\]/;

/** Every time the line names `name`, the words after it make a call that never acts on an account (`gh --version`). */
function onlyExempt(name: string, state: State): boolean {
  const { exempt, line } = state;
  if (!exempt) return false;
  const calls = [...line.matchAll(mention(name, "g"))].map((m) => line.slice(m.index + name.length).split(END_OF_CALL)[0]!.trim().split(/\s+/).filter(Boolean));
  return calls.length > 0 && calls.every((args) => exempt(name, args));
}

/** Guarded CLI names that appear as whole words in `text`, the whole line by default, other than to ask what it is. */
export function namedClis(state: State, text = state.line): string[] {
  return [...state.guarded].filter((name) => mention(name).test(text) && !onlyExempt(name, state));
}

/**
 * Something cloudpin can't read decides what runs (#162): each guarded CLI named in `text` (or the line) can't tell. A
 * call already read is why the line names it, and ran before what can't be read: `gh pr list; . <(cat f)`, or the output
 * of a checked call, as in `source <(kubectl completion bash)`.
 */
export function cantTell(text: string, wholeLine: boolean, out: Invocation[], env: Record<string, string>, state: State): void {
  for (const name of new Set([...namedClis(state, text), ...(wholeLine ? namedClis(state) : [])])) {
    const read = out.filter((call) => commandName(call.bin) === name).length;
    if (read < [...state.line.matchAll(mention(name, "g"))].length) out.push(invocation(name, [DYNAMIC_WORDS], env, state));
  }
}

/**
 * Whether the statement that ends at the operator `tokens[t]` is what PowerShell writes and bash would run: a lone `$c`
 * in `$files | ForEach-Object { ... }` or `if ($c) { ... }`. On Windows a line is read both ways when the agent doesn't
 * name its shell, and both are rare in bash, so a value is taken for a value there.
 */
export function psValue(tokens: Token[], t: number): boolean {
  const op = (k: number) => (tokens[k]?.kind === "op" ? (tokens[k] as { op: string }).op : undefined);
  if (op(t) === "|") return op(t - 1) !== "|" && op(t + 1) !== "|";
  const before = tokens[t - 3];
  return op(t) === ")" && op(t - 2) === "(" && before?.kind === "word" && ["if", "elif", "elseif", "while", "until", "switch"].includes(before.value);
}

/**
 * A word that is only an expansion, which bash runs as whatever it holds: `$c`, `"$c"`, `$(cat f)`. With text around it,
 * it is a path to a script, read no more than `./x.sh` is. PowerShell's `& $c[0]` and `& $c.Path` are one expression.
 */
export function wholeExpansion(word: string, quoted: boolean, expansions: Words[3][number], state: State): boolean {
  const only = expansions?.length === 1 ? expansions[0]! : undefined;
  return only !== undefined && only.at === 0 && (only.length === word.length || (state.dialect === "powershell" && !quoted));
}

/**
 * What a pipeline element hands the next command to read, in bash: the literal text of `echo` and of `cat` given a heredoc
 * or a here-string, or else text only known when it runs. `echo` may decode a backslash, and only the shell it runs in says how.
 */
export function pipedText([words, quoted, , expansions]: Words, stdin: string[], vars: Variables): string[] {
  if (words[0] === "cat" && stdin.length > 0 && (words.length === 1 || (words.length === 2 && /^(-|\/dev\/stdin)$/.test(words[1]!)))) return [stdin.at(-1)!];
  if (words[0] !== "echo") return [DYNAMIC_WORDS];
  let k = 1;
  while (!quoted[k] && /^-[neE]+$/.test(words[k] ?? "")) k++;
  const parts = words.slice(k).map((w, j) => (expansions[k + j] ? substitute(w, expansions[k + j]!, vars) : w));
  return parts.includes(undefined) || parts.join("").includes("\\") ? [DYNAMIC_WORDS] : [parts.join(" ")];
}

// Set-Alias's and New-Alias's parameters, and the common ones: a prefix of a name is that name when only one starts with it.
const ALIAS_VALUES = [
  "name", "value", "description", "option", "scope", "erroraction", "ea", "warningaction", "wa", "informationaction", "infa",
  "errorvariable", "ev", "warningvariable", "wv", "informationvariable", "iv", "outvariable", "ov", "outbuffer", "ob", "pipelinevariable", "pv",
];
const ALIAS_SWITCHES = ["force", "passthru", "whatif", "wi", "confirm", "cf", "verbose", "vb", "debug", "db"];
const SET_ALIAS = new Set(["set-alias", "sal", "new-alias", "nal"]);
const SET_ITEM = new Set(["set-item", "si", "new-item", "ni"]);

/** `Set-Alias [-Name] a [-Value] az`: an alias works from the next statement on, and takes no arguments of its own. */
function readSetAlias(args: EnvArg[], state: State, vars: Variables): "read" | "unknown" {
  const named: Record<string, EnvArg> = {};
  const rest: EnvArg[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k]!;
    const flag = arg.quoted ? null : /^-([A-Za-z]+)(?::(.*))?$/s.exec(arg.raw);
    if (!flag) {
      rest.push(arg);
      continue;
    }
    const key = flag[1]!.toLowerCase();
    const names = [...ALIAS_VALUES, ...ALIAS_SWITCHES];
    const matches = names.includes(key) ? [key] : names.filter((n) => n.startsWith(key));
    if (matches.length !== 1) return "unknown";
    if (ALIAS_SWITCHES.includes(matches[0]!)) continue;
    const given = flag[2] === undefined ? args[++k] : { ...arg, raw: flag[2], expansions: arg.expansions?.map((e) => ({ ...e, at: e.at - (arg.raw.length - flag[2]!.length) })) };
    if (given) named[matches[0]!] = given;
  }
  const read = (a: EnvArg | undefined) => (a?.expansions ? substitute(a.raw, a.expansions, vars) : a?.raw);
  const nameArg = named.name ?? rest.shift();
  const valueArg = named.value ?? rest.shift();
  if (!nameArg || !valueArg) return "read";
  const [name, value] = [read(nameArg), read(valueArg)];
  if (name === undefined || value === undefined) return "unknown";
  state.aliases = { ...state.aliases, [commandName(name)]: value };
  return "read";
}

/** `alias a=az b='gh pr'`, and `unalias`: in bash a whole line is read before any of it runs, so the next line sees them. */
function readBashAlias(name: string, args: EnvArg[], state: State, vars: Variables): "read" | "unknown" {
  const next = { ...(state.aliasesNext ?? state.aliases) };
  let result: "read" | "unknown" = "read";
  for (const arg of args) {
    if (name === "unalias") {
      if (arg.raw === "-a") for (const key of Object.keys(next)) delete next[key];
      else delete next[arg.raw];
      continue;
    }
    const text = arg.expansions ? substitute(arg.raw, arg.expansions, vars) : arg.raw;
    const set = text === undefined ? null : /^([^=]+)=(.*)$/s.exec(text);
    if (set) next[set[1]!] = set[2]!;
    else if (text === undefined) result = "unknown";
  }
  state.aliasesNext = next;
  return result;
}

/** Applies a command that defines aliases; false when `name` isn't one, "unknown" when the line can't say what it did. */
export function readAlias(name: string, args: EnvArg[], state: State, vars: Variables): false | "read" | "unknown" {
  if (state.dialect === "powershell") {
    if (SET_ITEM.has(name) && args.some((a) => /^(-\w+:)?alias:/i.test(a.raw))) return "unknown";
    return SET_ALIAS.has(name) ? readSetAlias(args, state, vars) : false;
  }
  return name === "alias" || name === "unalias" ? readBashAlias(name, args, state, vars) : false;
}

/** A new line, or text read as one: bash's aliases as the line before left them. */
export function nextAliases(state: State): void {
  if (state.aliasesNext) state.aliases = state.aliasesNext;
  delete state.aliasesNext;
}

/**
 * The statement with the alias at `words[i]` written out; "unknown" when it can't be, undefined when that's no alias.
 * With `others`, the aliases to read it with: one isn't read again inside itself (bash(1), ALIASES).
 */
export function withAlias([words, quoted, dynamic, expansions]: Words, i: number, state: State): { words: Words; others: Record<string, string> } | "unknown" | undefined {
  const powershell = state.dialect === "powershell";
  const key = powershell ? commandName(words[i]!) : words[i]!;
  const text = dynamic[i] || (quoted[i] && !powershell) ? undefined : state.aliases?.[key];
  if (text === undefined) return undefined;
  const tokens = powershell ? [{ kind: "word" as const, value: text, quoted: false, dynamic: false }] : tokenize(text);
  const parts = tokens.flatMap((t) => (t.kind === "word" ? [t] : []));
  if (parts.length !== tokens.length) return "unknown";
  const swap = <T>(list: T[], at: (t: (typeof parts)[number]) => T): T[] => [...list.slice(0, i), ...parts.map(at), ...list.slice(i + 1)];
  const others = Object.fromEntries(Object.entries(state.aliases!).filter(([k]) => k !== key));
  return { others, words: [swap(words, (t) => t.value), swap(quoted, (t) => t.quoted), swap(dynamic, (t) => t.dynamic), swap(expansions, (t) => t.expansions)] };
}

/** What a trap's string sees is what the line left when it runs, at the latest by the end (#163). Once, if that's as it was read. */
export function readTraps(from: number, out: Invocation[], state: State, read: (text: string, into: Invocation[]) => void): void {
  const later: Invocation[] = [];
  for (const text of state.atExit?.slice(from) ?? []) read(text, later);
  if (state.atExit) state.atExit = state.atExit.slice(0, from);
  out.push(...later.filter((call) => !out.some((seen) => JSON.stringify(seen) === JSON.stringify(call))));
}
