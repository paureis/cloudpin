import { homedir } from "node:os";
import { resolve } from "node:path";
import { commandName } from "./guard.js";

export interface Invocation {
  /** Executable as written, e.g. "gh" or "/usr/bin/gh". */
  bin: string;
  args: string[];
  /** VAR=value assignments written before the command. */
  env: Record<string, string>;
  /** Folder the call runs in, when a `cd` earlier in the line changed it. */
  cwd?: string;
}

type Token = { kind: "word"; value: string } | { kind: "op" };

/**
 * Splits a POSIX-shell command line into words and control operators.
 * Command substitutions ($(...) and backticks) are scanned separately and
 * reported through `onSubstitution`; their text does not become a word.
 */
function tokenize(input: string, onSubstitution: (inner: string) => void): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  const flush = () => {
    if (inWord) tokens.push({ kind: "word", value: word });
    word = "";
    inWord = false;
  };

  // Reads $( ... ) starting after "$(", honouring nesting and quotes.
  const readParen = (start: number): number => {
    let depth = 1;
    let i = start;
    let quote: string | null = null;
    for (; i < input.length && depth > 0; i++) {
      const c = input[i]!;
      if (quote) {
        if (c === "\\" && quote === '"') i++;
        else if (c === quote) quote = null;
      } else if (c === "'" || c === '"') quote = c;
      else if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    onSubstitution(input.slice(start, i - 1));
    return i;
  };
  const readBacktick = (start: number): number => {
    let i = start;
    while (i < input.length && input[i] !== "`") i += input[i] === "\\" ? 2 : 1;
    onSubstitution(input.slice(start, i));
    return i + 1;
  };

  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      const stop = end === -1 ? input.length : end;
      word += input.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      while (i < input.length && input[i] !== '"') {
        const d = input[i]!;
        if (d === "\\" && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1]!)) {
          word += input[i + 1];
          i += 2;
        } else if (d === "$" && input[i + 1] === "(") i = readParen(i + 2);
        else if (d === "`") i = readBacktick(i + 1);
        else {
          word += d;
          i++;
        }
      }
      i++;
    } else if (c === "\\") {
      if (i + 1 < input.length && input[i + 1] !== "\n") {
        word += input[i + 1];
        inWord = true;
      }
      i += 2;
    } else if (c === "$" && input[i + 1] === "(") {
      inWord = true;
      i = readParen(i + 2);
    } else if (c === "`") {
      inWord = true;
      i = readBacktick(i + 1);
    } else if (" \t\r".includes(c)) {
      flush();
      i++;
    } else if (";&|()\n".includes(c)) {
      flush();
      tokens.push({ kind: "op" });
      i++;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  flush();
  return tokens;
}

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
// Words that run the command after them (shell keywords, prefixes, runners).
const PASS_THROUGH = new Set([
  "sudo", "command", "time", "nohup", "exec", "builtin", "nice",
  "npx", "bunx", "{", "!", "if", "then", "else", "elif", "while", "until", "do",
]);
// Runners whose second word is a subcommand, e.g. `pnpm dlx vercel`.
const RUNNER_SUBCOMMANDS: Record<string, string[]> = {
  pnpm: ["dlx", "exec"],
  yarn: ["dlx", "exec"],
  npm: ["exec", "x"],
  bun: ["x"],
};
// Wrappers with flags that take a value, and how many positional words
// (e.g. timeout's duration) come before the wrapped command.
const VALUE_WRAPPERS: Record<string, { valueFlags: string[]; positionals: number }> = {
  timeout: { valueFlags: ["-s", "-k", "--signal", "--kill-after"], positionals: 1 },
  xargs: { valueFlags: ["-n", "-I", "-i", "-P", "-L", "-l", "-d", "-a", "-E", "-e", "-s"], positionals: 0 },
};
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const POWERSHELLS = new Set(["pwsh", "powershell"]);

interface State {
  /** Working directory after any `cd` seen so far; undefined until one is. */
  cwd?: string;
  base?: string;
}

function analyse(words: string[], guarded: Set<string>, out: Invocation[], state: State): void {
  if (words[0] === "cd") {
    const target = words[1];
    if (target !== undefined && target !== "-") {
      const expanded = target === "~" || target.startsWith("~/") ? homedir() + target.slice(1) : target;
      state.cwd = resolve(state.cwd ?? state.base ?? ".", expanded);
    }
    return;
  }
  const env: Record<string, string> = {};
  let i = 0;
  for (;;) {
    const word = words[i];
    if (word === undefined) return;
    const assignment = ASSIGNMENT.exec(word);
    const name = commandName(word);
    const wrapper = VALUE_WRAPPERS[name];
    if (assignment) {
      env[assignment[1]!] = assignment[2]!;
      i++;
    } else if (wrapper) {
      i++;
      while (words[i]?.startsWith("-")) {
        const flag = words[i]!;
        i += wrapper.valueFlags.includes(flag) ? 2 : 1;
      }
      i += wrapper.positionals;
    } else if (name === "env" || PASS_THROUGH.has(name)) {
      i++;
      // Skip the wrapper's own flags (sudo -u root, npx --yes, env -i).
      while (words[i]?.startsWith("-")) i += words[i] === "-u" ? 2 : 1;
    } else if (RUNNER_SUBCOMMANDS[name]?.includes(words[i + 1] ?? "")) {
      i += 2;
      while (words[i]?.startsWith("-")) i++;
    } else {
      break;
    }
  }
  const bin = words[i]!;
  const name = commandName(bin);
  const args = words.slice(i + 1);
  if (guarded.has(name)) {
    out.push(state.cwd === undefined ? { bin, args, env } : { bin, args, env, cwd: state.cwd });
  } else if (SHELLS.has(name) || POWERSHELLS.has(name)) {
    const flag = args.findIndex((a) =>
      SHELLS.has(name) ? /^-[a-z]*c$/.test(a) : /^-(c|command)$/i.test(a),
    );
    const script = flag === -1 ? undefined : args[flag + 1];
    if (script !== undefined) collect(script, guarded, out, state);
  }
}

function collect(input: string, guarded: Set<string>, out: Invocation[], state: State): void {
  const tokens = tokenize(input, (inner) => collect(inner, guarded, out, state));
  let segment: string[] = [];
  for (const token of [...tokens, { kind: "op" } as const]) {
    if (token.kind === "word") {
      segment.push(token.value);
    } else if (segment.length > 0) {
      analyse(segment, guarded, out, state);
      segment = [];
    }
  }
}

/**
 * Finds every call to a guarded CLI in a shell command line, including inside
 * pipelines, lists, subshells, command substitutions and `bash -c` strings.
 * With `baseCwd`, a `cd` earlier in the line sets the call's `cwd`, so
 * `cd ../other && vercel deploy` is checked against ../other's pins. Subshell
 * scoping of `cd` is not modelled: a later call may get a deeper folder.
 */
export function findInvocations(command: string, guardedBins: string[], baseCwd?: string): Invocation[] {
  const out: Invocation[] = [];
  collect(command, new Set(guardedBins), out, { base: baseCwd });
  return out;
}
