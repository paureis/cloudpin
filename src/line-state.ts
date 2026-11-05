import { psVariables } from "./ps-words.js";
import { UNKNOWN_VALUE } from "./types.js";
import type { Variables } from "./word-expansion.js";

// What `shellwords.ts` keeps while it reads a line: the shell, the folder and the variables so far.

/** The shell that reads the line: bash (also sh, zsh, Git Bash) or PowerShell (5.1 or 7) (#159). */
export type Dialect = "bash" | "powershell";

export interface State {
  /** Working directory after any `cd` seen so far; undefined until one is, UNKNOWN_FOLDER once it can't be read. */
  cwd?: string;
  base?: string;
  /** While `cwd` is UNKNOWN_FOLDER: the last folder the line knew (#163). */
  known?: string;
  /** Where `cd -` goes; undefined when the line doesn't know (#163). */
  previous?: string;
  /** What `pushd` left in this line, for `popd`; below it the stack is unknown (#163). Never changed in place. */
  stack?: readonly string[];
  /** Variables set by plain `NAME=value` commands earlier in the line. */
  vars: Record<string, string>;
  /** Of those, the ones the shell passes to the commands it runs: `export`ed, or PowerShell `$env:` (#86). */
  exported: Record<string, string>;
  /** Plain `NAME=value` assignments not exported here: they reach a command only if NAME was already exported. */
  plain: Record<string, string>;
  /** Names `unset` and not set again since. */
  unset: Set<string>;
  /** The whole command line, to spot CLI names behind an unknown `$VAR` command. */
  line: string;
  guarded: Set<string>;
  /** The environment the line starts in, when given: only to tell that an unknown variable is one word (#160). */
  env?: NodeJS.ProcessEnv;
  dialect: Dialect;
  /** PowerShell variables set from something other than one literal, which may be several words (#159). */
  lists: Set<string>;
  /** What a wrapper did to the environment of the call it runs (#162): `env -i`, `env -u NAME`. */
  clearEnv?: boolean;
  callUnset?: string[];
  /** After `set -a`: every assignment exports (#163). */
  allexport?: boolean;
  /** Something earlier may have set any variable, which cloudpin can't read (#163): `. file`, `export $(...)`. */
  envUnknown?: boolean;
  /** Names `export X` marked with no value yet: the next assignment exports them (#163). */
  marked?: string[];
  /** Names `local` set, which end with their function (#163). */
  locals?: string[];
  /** What each alias of this line stands for (#163), by name; DYNAMIC_WORDS when the line can't say. */
  aliases?: Record<string, string>;
  /** bash reads a whole line before it runs any of it: the aliases the next line will see (#163). */
  aliasesNext?: Record<string, string>;
  /** The statement being read is a bare value in what looks like PowerShell's writing: see `psValue` (#163). */
  asValue?: boolean;
  /** The strings `trap` keeps, which run later (#163). */
  atExit?: string[];
  /** Whether a call is one that never acts on an account; only the check knows (#163). */
  exempt?: (name: string, args: string[]) => boolean;
}

/** The variables the line set, as word expansion reads them (#160). */
export const variables = (state: State): Variables => (state.dialect === "powershell" ? psVariables(state) : {
  known(name) {
    if (state.unset.has(name)) return "";
    const value = state.vars[name];
    return value === UNKNOWN_VALUE ? undefined : value;
  },
  oneWord(name) {
    // Never its value, which may be a secret: only that it can't split or be a flag.
    const value = name in state.vars ? undefined : state.env?.[name];
    return value !== undefined && !/\s/.test(value) && !value.startsWith("-");
  },
});

/** A copy for code that runs in a child shell, whose `cd` and variables do not come back. */
export const child = (state: State): State => ({
  ...state,
  vars: { ...state.vars },
  exported: { ...state.exported },
  plain: { ...state.plain },
  unset: new Set(state.unset),
  lists: new Set(state.lists),
});

/** Back to where `to` is: a child shell's or a job's folder doesn't come back (#163). */
export function restoreFolder(state: State, to: Pick<State, "cwd" | "known" | "previous" | "stack">): void {
  state.cwd = to.cwd;
  state.known = to.known;
  state.previous = to.previous;
  state.stack = to.stack;
}

/** Back to what `to` holds: a child shell's variables don't come back. */
export function restoreEnv(state: State, to: State): void {
  state.vars = to.vars;
  state.exported = to.exported;
  state.plain = to.plain;
  state.unset = to.unset;
  for (const key of ["allexport", "envUnknown", "marked", "locals", "callUnset"] as const) {
    if (to[key] === undefined) delete state[key];
    else (state[key] as unknown) = to[key];
  }
}

/** Sets NAME for the rest of the line, exported or not. */
export function assign(state: State, name: string, value: string, exported: boolean): void {
  state.vars[name] = value;
  state.unset.delete(name);
  // Assigning to an exported variable updates what commands receive, and after `set -a` every assignment exports.
  if (exported || state.allexport || name in state.exported || state.marked?.includes(name)) {
    state.exported[name] = value;
    delete state.plain[name];
  } else state.plain[name] = value;
}
