import { commandName } from "./guard.js";

export interface Invocation {
  /** Executable as written, e.g. "gh" or "/usr/bin/gh". */
  bin: string;
  args: string[];
  /** VAR=value assignments written before the command. */
  env: Record<string, string>;
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
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const POWERSHELLS = new Set(["pwsh", "powershell"]);

function analyse(words: string[], guarded: Set<string>, out: Invocation[]): void {
  const env: Record<string, string> = {};
  let i = 0;
  for (;;) {
    const word = words[i];
    if (word === undefined) return;
    const assignment = ASSIGNMENT.exec(word);
    const name = commandName(word);
    if (assignment) {
      env[assignment[1]!] = assignment[2]!;
      i++;
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
    out.push({ bin, args, env });
  } else if (SHELLS.has(name) || POWERSHELLS.has(name)) {
    const flag = args.findIndex((a) =>
      SHELLS.has(name) ? /^-[a-z]*c$/.test(a) : /^-(c|command)$/i.test(a),
    );
    const script = flag === -1 ? undefined : args[flag + 1];
    if (script !== undefined) collect(script, guarded, out);
  }
}

function collect(input: string, guarded: Set<string>, out: Invocation[]): void {
  const tokens = tokenize(input, (inner) => collect(inner, guarded, out));
  let segment: string[] = [];
  for (const token of [...tokens, { kind: "op" } as const]) {
    if (token.kind === "word") {
      segment.push(token.value);
    } else if (segment.length > 0) {
      analyse(segment, guarded, out);
      segment = [];
    }
  }
}

/**
 * Finds every call to a guarded CLI in a shell command line, including inside
 * pipelines, lists, subshells, command substitutions and `bash -c` strings.
 */
export function findInvocations(command: string, guardedBins: string[]): Invocation[] {
  const out: Invocation[] = [];
  collect(command, new Set(guardedBins), out);
  return out;
}
