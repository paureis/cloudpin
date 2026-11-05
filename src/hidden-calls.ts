import type { Invocation } from "./invocation.js";
import type { State } from "./line-state.js";
import { DYNAMIC_WORDS, UNKNOWN_FOLDER } from "./types.js";

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

/** Guarded CLI names that appear as whole words in `text`, the whole line by default. */
export function namedClis(state: State, text = state.line): string[] {
  return [...state.guarded].filter((name) =>
    new RegExp(`(^|[^A-Za-z0-9_.-])${name.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)}([^A-Za-z0-9_.-]|$)`).test(text),
  );
}

/** Something cloudpin can't read decides what runs (#162): each guarded CLI named in `text` (or the line) can't tell. */
export function cantTell(text: string, wholeLine: boolean, out: Invocation[], env: Record<string, string>, state: State): void {
  for (const name of new Set([...namedClis(state, text), ...(wholeLine ? namedClis(state) : [])])) {
    out.push(invocation(name, [DYNAMIC_WORDS], env, state));
  }
}
