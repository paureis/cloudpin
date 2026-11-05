import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { commandName } from "./guard.js";
import type { Dialect, State } from "./line-state.js";
import type { Expansion } from "./shell-tokens.js";
import { UNKNOWN_FOLDER } from "./types.js";
import { expandWord, isDynamic, type Variables } from "./word-expansion.js";

/**
 * The folder a line's commands move to (#163): each spelling is followed where it can be read, and anything
 * else makes the folder UNKNOWN_FOLDER, which guard stops as "can't tell" with a pin file in sight. Each rule was checked against real Git
 * Bash and Windows PowerShell 5.1 with a printer (bash(1) SHELL BUILTIN COMMANDS; about_Locations,
 * Set-Location, Push-Location and Pop-Location in the PowerShell docs).
 *
 * A command the shell rejects leaves the folder where it was, so the next `;` runs there: bash's `cd -Path x`
 * and PowerShell's `cd -P x`. That also keeps a line read both ways on Windows from stopping on the other shell's
 * spelling. What depends on the shell is not read: bash has no `chdir`, zsh and dash do; PowerShell 7 moves on
 * a bare `cd` and on `cd -`, 5.1 doesn't; an empty stack may be one an earlier command left.
 */

type Command = "cd" | "pushd" | "popd" | "chdir";

const POWERSHELL_COMMANDS = new Map<string, Command>([
  ["cd", "cd"], ["chdir", "cd"], ["sl", "cd"], ["set-location", "cd"],
  ["pushd", "pushd"], ["push-location", "pushd"],
  ["popd", "popd"], ["pop-location", "popd"],
]);
const BASH_COMMANDS = new Set(["cd", "pushd", "popd", "chdir"]);

/** The command `bin` moves the folder with. PowerShell's names ignore case; bash's don't (`CD x` is not found). */
export function folderCommand(bin: string, dialect: Dialect): Command | undefined {
  if (dialect === "powershell") return POWERSHELL_COMMANDS.get(commandName(bin));
  return BASH_COMMANDS.has(bin) ? (bin as Command) : undefined;
}

/** One argument as typed, with what `shellwords.ts` knows of it. */
export interface FolderArg {
  raw: string;
  quoted: boolean;
  expansions?: Expansion[] | undefined;
}
interface Word {
  value: string;
  quoted: boolean;
  /** A variable or the like gave part of it, so a quote doesn't say which part is text. */
  expanded: boolean;
  literal?: boolean;
}
type Move = "stay" | "unknown" | "home" | "back" | "swap" | "pop" | Word;

function readBash(command: Command, words: Word[]): Move {
  if (command === "chdir" || words.some((w) => isDynamic(w.value))) return "unknown";
  // A count or -n needs the stack, which may hold what an earlier command left.
  if (command === "popd") return words.length === 0 ? "pop" : "unknown";
  let k = 0;
  for (; k < words.length; k++) {
    const value = words[k]!.value;
    if (value === "--") {
      k++;
      break;
    }
    if (value === "-" || !value.startsWith("-")) break;
    if (command === "cd" && /^-[LPe]+$/.test(value)) continue;
    // `-2` is zsh's stack, `-@` only some builds of bash take, and `pushd -n` keeps the folder.
    if (/^-(\d+|@)$/.test(value) || (command === "pushd" && value === "-n")) return "unknown";
    return "stay";
  }
  const rest = words.slice(k);
  if (rest.length > 1) return "unknown";
  const word = rest[0];
  if (word === undefined) return command === "cd" ? "home" : "swap";
  if (word.value === "-") return command === "cd" ? "back" : "unknown";
  return command === "pushd" && /^\+\d+$/.test(word.value) ? "unknown" : word;
}

// Set-Location's and Push-Location's parameters, and the common ones. A prefix of a full name is that parameter
// when only one starts with it (`-Pat`, `-L`); `-P` and `-Pa` are errors. 5.1 has no -LP, 7 does.
const PS_PARAMETERS: [name: string, takes: "path" | "literal" | "none" | "value" | "stop"][] = [
  ["path", "path"], ["literalpath", "literal"], ["pspath", "literal"], ["passthru", "none"], ["stackname", "stop"],
  ["verbose", "none"], ["debug", "none"], ["erroraction", "value"], ["warningaction", "value"], ["informationaction", "value"],
  ["progressaction", "value"], ["errorvariable", "value"], ["warningvariable", "value"], ["informationvariable", "value"],
  ["outvariable", "value"], ["outbuffer", "value"], ["pipelinevariable", "value"],
];
const PS_ALIASES = new Map([
  ["vb", "none"], ["db", "none"], ["ea", "value"], ["wa", "value"], ["infa", "value"], ["proga", "value"], ["ev", "value"],
  ["wv", "value"], ["iv", "value"], ["ov", "value"], ["ob", "value"], ["pv", "value"], ["lp", "stop"],
]);
function psParameter(name: string): string | undefined {
  const key = name.toLowerCase();
  const alias = PS_ALIASES.get(key);
  if (alias) return alias;
  const matches = PS_PARAMETERS.filter(([full]) => full.startsWith(key));
  return (PS_PARAMETERS.find(([full]) => full === key) ?? (matches.length === 1 ? matches[0] : undefined))?.[1];
}

function readPowerShell(command: Command, words: Word[]): Move {
  if (words.some((w) => isDynamic(w.value))) return "unknown";
  let path: Word | undefined;
  let named = true;
  for (let k = 0; k < words.length; k++) {
    const word = words[k]!;
    const flag = named ? /^-([A-Za-z]+)(?::(.*))?$/s.exec(word.value) : null;
    if (named && !word.quoted && word.value === "--") named = false;
    else if (flag && (!word.quoted || flag[2] !== undefined)) {
      const takes = psParameter(flag[1]!);
      if (takes === undefined) return "stay";
      if (takes === "stop") return "unknown";
      if (takes === "value" && flag[2] === undefined) k++;
      if (takes !== "path" && takes !== "literal") continue;
      const value = flag[2] !== undefined ? { ...word, value: flag[2] } : words[++k];
      if (value === undefined) return "stay";
      if (path) return "unknown";
      path = { ...value, literal: takes === "literal" };
    } else if (path) return "unknown";
    else path = word;
  }
  // A bare Set-Location may take its folder from the pipe, or go home in 7; Pop-Location has no path.
  if (command === "popd") return path ? "unknown" : "pop";
  return path ?? "unknown";
}

/**
 * A Git Bash path as Windows reads it: `/c/x` is `C:/x`, and `/tmp` is %TEMP% (Git for Windows' /etc/fstab). Any
 * other absolute path is under a mount only it knows, so undefined. The same text elsewhere is that path.
 */
export function gitBashPath(path: string, platform: NodeJS.Platform = process.platform, temp?: string): string | undefined {
  if (platform !== "win32" || !path.startsWith("/") || path.startsWith("//")) return path;
  const drive = /^\/([A-Za-z])(\/.*)?$/.exec(path);
  if (drive) return `${drive[1]!.toUpperCase()}:${drive[2] ?? "/"}`;
  return temp && /^\/tmp(\/|$)/.test(path) ? temp + path.slice(4) : undefined;
}

/** What bash takes the word for, or undefined when only bash can say. */
function bashTarget(word: Word, home: string, cdpath: string | undefined, temp: string | undefined): string | undefined {
  const value = word.value;
  if (value === "") return undefined;
  // In quotes [ and { are text (`"app/[id]"`), and * and ? nearly always a glob beside the quotes (`"$D"/*`).
  if (/[*?]/.test(value) || (/[[{]/.test(value) && (!word.quoted || word.expanded))) return undefined;
  if (value.startsWith("~")) {
    return !word.quoted && /^~(\/|$)/.test(value) ? gitBashPath(home + value.slice(1), process.platform, temp) : undefined;
  }
  // bash looks for a bare relative folder under $CDPATH first (bash(1), cd).
  if (cdpath && !/^(\.\.?(\/|$)|\/)/.test(value) && !isAbsolute(value)) return undefined;
  return gitBashPath(value, process.platform, temp);
}

/** What Set-Location takes the word for, or undefined when it isn't a folder cloudpin can name. */
function powerShellTarget(word: Word): string | undefined {
  const value = word.value;
  if (value === "" || value === "-" || value === "+") return undefined;
  // A provider's path (`Env:`, `HKCU:\`, `FileSystem::x`), or a folder on a drive that keeps its own (`C:`, `C:x`).
  if (value.includes("::") || /^[^\\/:]{2,}:/.test(value) || /^[^\\/:]:(?![\\/])/.test(value)) return undefined;
  if (!word.literal && /[*?[]/.test(value)) return undefined;
  return /^~($|[\\/])/.test(value) ? homedir() + value.slice(1) : value;
}

/** `vars` plus the hook's environment (owner decision 4, #163), where the line didn't set the name. */
function withEnvironment(state: State, vars: Variables, current: string): Variables {
  const here = current === UNKNOWN_FOLDER ? undefined : current;
  const env = state.env ?? {};
  if (state.dialect === "powershell") {
    return {
      ...vars,
      known(name) {
        const lower = name.toLowerCase();
        if (lower === "pwd") return here;
        if (lower === "home") return homedir();
        const value = vars.known(name);
        if (value !== undefined || !lower.startsWith("env:")) return value;
        const key = lower.slice(4);
        // Set on the line to something unknown.
        if (Object.keys(state.exported).some((k) => k.toLowerCase() === key)) return undefined;
        return Object.entries(env).find(([k]) => k.toLowerCase() === key)?.[1];
      },
    };
  }
  return {
    ...vars,
    known(name) {
      if (name === "PWD") return here;
      if (name === "OLDPWD") return state.previous === UNKNOWN_FOLDER ? undefined : state.previous;
      return vars.known(name) ?? (name in state.vars ? undefined : env[name]);
    },
  };
}

/** `to` from `current`: an absolute folder is known wherever the line is, a relative one only from a known one. */
export function joinFolder(current: string, to: string): string {
  return to === UNKNOWN_FOLDER || (current === UNKNOWN_FOLDER && !isAbsolute(to)) ? UNKNOWN_FOLDER : resolve(current, to);
}

/** The folder from here on, keeping the last one the line knew when this one is unknown. */
export function setFolder(state: Pick<State, "cwd" | "base" | "known">, to: string): void {
  if (to === UNKNOWN_FOLDER && state.cwd !== UNKNOWN_FOLDER) state.known = state.cwd ?? state.base;
  state.cwd = to;
}

/** The line can't say where it is from here: its folder, and what it could go back to. */
export function loseFolder(state: State): void {
  setFolder(state, UNKNOWN_FOLDER);
  delete state.previous;
  state.stack = [];
}

/** Applies a folder command to the line's state. `env` holds the assignments in front of it (`CDPATH=x cd y`). */
export function moveFolder(state: State, command: Command, args: FolderArg[], vars: Variables, env: Record<string, string>): void {
  const current = state.cwd ?? state.base ?? resolve(".");
  const known = withEnvironment(state, vars, current);
  const words = args.flatMap(({ raw, quoted, expansions }): Word[] =>
    expansions
      ? expandWord(raw, expansions, quoted, known).map((value) => ({ value, quoted, expanded: true }))
      : [{ value: raw, quoted, expanded: false }],
  );
  const powershell = state.dialect === "powershell";
  const move = powershell ? readPowerShell(command, words) : readBash(command, words);
  if (move === "stay") return;
  const stack = state.stack ?? [];
  const home = known.known("HOME") || homedir();
  const cdpath = env.CDPATH ?? (state.unset.has("CDPATH") ? undefined : (state.vars.CDPATH ?? state.env?.CDPATH));
  const temp = state.env?.TEMP;
  let to: string | undefined;
  let next = stack;
  if (move === "unknown") to = undefined;
  else if (move === "home") to = gitBashPath(home, process.platform, temp);
  else if (move === "back") to = state.previous;
  else if (move === "swap") [to, next] = [stack.at(-1), [...stack.slice(0, -1), current]];
  else if (move === "pop") [to, next] = [stack.at(-1), stack.slice(0, -1)];
  else {
    to = powershell ? powerShellTarget(move) : bashTarget(move, home, cdpath, temp);
    if (command === "pushd") next = [...stack, current];
  }
  if (to === undefined) return loseFolder(state);
  state.previous = current;
  state.stack = next;
  setFolder(state, joinFolder(current, to));
}
