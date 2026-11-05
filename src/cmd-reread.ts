import { win32 } from "node:path";
import { cantTell, invocation } from "./hidden-calls.js";
import type { Invocation } from "./invocation.js";
import type { CmdFile, Dialect, State } from "./line-state.js";
import { splitCommandLine, windowsPowerShellLine } from "./ps-tokens.js";
import type { Words } from "./ps-words.js";
import { UNKNOWN_VALUE } from "./types.js";
import { envFor } from "./user-env.js";
import { expandWord, isDynamic, type Variables } from "./word-expansion.js";

/**
 * cmd.exe re-reads the command line of a .cmd or .bat file, so what cloudpin read as one value may start another command,
 * lose the flags after it or become a flag (#168). That reading is not followed: what cmd.exe would act on is "can't tell".
 * Each rule was checked against real Windows PowerShell 5.1 and Git Bash with printers shaped like the real az.cmd and
 * npm's cmd-shim. PowerShell 7.3+ is from its docs, not measured: about_Preference_Variables,
 * $PSNativeCommandArgumentPassing, keeps Legacy passing for .bat and .cmd, "as raw command-line strings to cmd.exe".
 *
 * - `"` toggles, wherever it came from; outside quotes & | < > ^ act, and ) too, since az.cmd runs its program inside
 *   `IF ( )`. Every .cmd is read alike: an npm shim has no such block, but a `)` in its arguments is rare;
 * - %NAME% expands anywhere, also in quotes; !NAME! stays literal, as delayed expansion is off;
 * - a newline cuts the line wherever it is, and the flags after it are lost; a carriage return is dropped from the word;
 * - PowerShell runs a .ps1 beside a .cmd of that name, or refuses it by policy, so that never reaches cmd.exe;
 * - Git Bash runs the extensionless script, unless the name typed is the .cmd.
 */

/** What cmd.exe would act on in the command line `line`, as a class of character: never a value. */
export function cmdReads(line: string): string | undefined {
  if (/[\r\n]/.test(line)) return "a newline";
  if (/%[^%]+%/.test(line)) return "%NAME%";
  let inQuotes = false;
  for (const c of line) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && "&|<>^)".includes(c)) return `an unquoted ${c}`;
  }
  return undefined;
}

/** The command line Git Bash builds, as cmd.exe toggles on it: a word with a space or a quote is wrapped (its quotes become \", still quotes to cmd.exe). */
const gitBashLine = (args: readonly string[]) => args.map((a) => (/[ \t\r\n"]/.test(a) ? `"${a}"` : a)).join(" ");

/**
 * The arguments as the shell passes them, with the text around a part only known when it runs (which `expandWord` drops:
 * `"$id&x"`) and that part at its worst: nothing in it adds quotes or closes them.
 */
function shellWords([words, quoted, , expansions]: Words, from: number, vars: Variables): string[] {
  return words.slice(from).flatMap((word, k) => {
    const parts = expansions[from + k];
    if (!parts) return [word];
    const expanded = expandWord(word, parts, quoted[from + k] ?? false, vars);
    if (!expanded.some(isDynamic)) return expanded;
    let text = "";
    let pos = 0;
    for (const e of parts) {
      text += word.slice(pos, e.at) + ((e.name === undefined ? undefined : vars.known(e.name)) ?? "x");
      pos = e.at + e.length;
    }
    return [text + word.slice(pos)];
  });
}

const CMD_FILE = /\.(cmd|bat)$/i;

/** How to tell a name runs through cmd.exe; none outside Windows, or with no way to look it up. Spawns nothing. */
export function cmdFileLookup(onPath: ((bin: string, env: NodeJS.ProcessEnv) => string | null) | undefined, platform: NodeJS.Platform): CmdFile | undefined {
  if (platform !== "win32" || !onPath) return undefined;
  return (name: string, env: NodeJS.ProcessEnv, dialect: Dialect, cwd: string | undefined) => {
    if (CMD_FILE.test(name)) return true;
    if (dialect === "bash") return false;
    const value = (key: string) => Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1];
    // A PATH only known when it runs may lead to a .cmd.
    if (value("PATH")?.includes(UNKNOWN_VALUE)) return true;
    const base = win32.basename(name);
    const pathext = value("PATHEXT");
    // A path typed without its extension is looked for in its own folder.
    const there = /[\\/]/.test(name) ? { PATH: win32.resolve(cwd ?? ".", win32.dirname(name)), ...(pathext ? { PATHEXT: pathext } : {}) } : env;
    const file = onPath(base, there);
    if (file === null || !CMD_FILE.test(file)) return false;
    const script = onPath(`${base}.ps1`, there);
    return script === null || win32.dirname(script).toLowerCase() !== win32.dirname(file).toLowerCase();
  };
}

/** The call's own environment: what the line set replaces the hook's, in whatever spelling (Windows names ignore case). */
function callEnv(inv: Invocation, state: State): NodeJS.ProcessEnv {
  const set = new Set(Object.keys(inv.env).map((k) => k.toUpperCase()));
  const base = Object.fromEntries(Object.entries(state.env ?? {}).filter(([k]) => !set.has(k.toUpperCase())));
  return envFor(base, inv, { platform: "win32" });
}

/**
 * For a call to `bin`, the words after it at `all[0][from]`: what to do once its calls are out, when `bin` or the wrapper it
 * runs through goes through cmd.exe and cmd.exe would act on its command line. Those calls can't tell, and neither can a
 * guarded CLI the words name, which cmd.exe may run (`'x&kubectl'`). The line is scanned first, so most calls never look at PATH.
 */
export function cmdRereads(bin: string, wrapper: string | undefined, all: Words, from: number, vars: Variables, env: Record<string, string>, out: Invocation[], state: State): (() => void) | undefined {
  if (!state.cmdFile) return undefined;
  const args = shellWords(all, from, vars);
  // After --% the text goes as typed, so its quotes are the ones cmd.exe sees, not the ones its words were split by.
  const typed = state.typed;
  const words = typed === undefined ? args : args.slice(0, args.length - splitCommandLine(typed, true).length);
  const line = state.dialect === "powershell" ? windowsPowerShellLine(words) : gitBashLine(words);
  const what = cmdReads(typed === undefined ? line : `${line} ${typed}`);
  if (what === undefined) return undefined;
  const callsEnv = callEnv(invocation(bin, [], env, state), state);
  const cwd = state.cwd ?? state.base;
  if (![bin, wrapper].some((name) => name !== undefined && state.cmdFile!(name, callsEnv, state.dialect, cwd))) return undefined;
  const at = out.length;
  return () => {
    cantTell(all[0].slice(from).join(" "), false, out, env, state);
    for (const call of out.slice(at)) call.cmdReread = what;
  };
}
