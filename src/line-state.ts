import { psVariables } from "./ps-words.js";
import { UNKNOWN_VALUE } from "./types.js";
import type { Variables } from "./word-expansion.js";

// What `shellwords.ts` keeps while it reads a line: the shell, the folder and the variables so far.

/** The shell that reads the line: bash (also sh, zsh, Git Bash) or PowerShell (5.1 or 7) (#159). */
export type Dialect = "bash" | "powershell";

export interface State {
  /** Working directory after any `cd` seen so far; undefined until one is. */
  cwd?: string;
  base?: string;
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

/** Sets NAME for the rest of the line, exported or not. */
export function assign(state: State, name: string, value: string, exported: boolean): void {
  state.vars[name] = value;
  state.unset.delete(name);
  // Assigning to an exported variable updates what commands receive.
  if (exported || name in state.exported) {
    state.exported[name] = value;
    delete state.plain[name];
  } else state.plain[name] = value;
}
