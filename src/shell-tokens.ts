import { isStream, redirection } from "./redirections.js";

export type Token =
  /**
   * `quoted`: some of it was in quotes, so `"vercel"` is a string, not a command.
   * `dynamic`: it contains `$(...)`, `<(...)`, backticks or a `$NAME` expansion, so its value is only known when it runs.
   */
  | { kind: "word"; value: string; quoted: boolean; dynamic: boolean }
  /** A control operator: ; & | newline, or ( and ) which open and close a subshell. */
  | { kind: "op"; op: string }
  /** $( ... ), <( ... ), >( ... ) or backticks: a command line run in a subshell. */
  | { kind: "subst"; inner: string }
  /** A heredoc or here-string: text the command reads on its standard input. */
  | { kind: "stdin"; body: string };

/**
 * Splits a POSIX-shell command line into words, control operators, command
 * substitutions and heredoc bodies, in the order they appear.
 */
export function tokenize(input: string): Token[] {
  // Git Bash drops every carriage return it reads, inside quotes too, so `\` + CRLF continues the line;
  // only a decoded $'\r' keeps one (#161).
  return scan(input.replace(/\r/g, ""), 0, false).tokens;
}

/**
 * Reads from `from` to the end of the input or, when `nested` in a `$( )`, to the `)` that closes it;
 * `end` is the index after that `)`.
 */
function scan(input: string, from: number, nested: boolean): { tokens: Token[]; end: number; closed: boolean } {
  const tokens: Token[] = [];
  // Subshells opened by ( and not closed yet, inside this $( ).
  let depth = 0;
  let word = "";
  let inWord = false;
  let quoted = false;
  let dynamic = false;
  // The next word is a here-string (`<<< word`), not an argument.
  let hereString = false;
  // The next word is a redirection's target (#154).
  let target = false;
  // Heredocs whose bodies start after the next newline.
  const pending: { token: { kind: "stdin"; body: string }; delimiter: string; stripTabs: boolean }[] = [];
  const flush = () => {
    if (inWord && !target) tokens.push(hereString ? { kind: "stdin", body: word } : { kind: "word", value: word, quoted, dynamic });
    if (inWord) hereString = target = false;
    word = "";
    inWord = false;
    quoted = false;
    dynamic = false;
  };
  // `$NAME` or `${NAME}` (not `$` alone or `$1`): an expansion outside single quotes.
  const expands = (at: number) => /[A-Za-z_{]/.test(input[at + 1] ?? "");

  // Reads $( ... ), <( ... ) or >( ... ) starting after the "(", with this same tokenizer, so quotes,
  // comments and heredoc bodies inside it are read as on the outer line (#161).
  const readParen = (start: number): number => {
    const { end, closed } = scan(input, start, true);
    tokens.push({ kind: "subst", inner: input.slice(start, closed ? end - 1 : end) });
    return end;
  };
  const readBacktick = (start: number): number => {
    let i = start;
    while (i < input.length && input[i] !== "`") i += input[i] === "\\" ? 2 : 1;
    tokens.push({ kind: "subst", inner: input.slice(start, i) });
    return i + 1;
  };
  // Reads a heredoc delimiter word, removing its quotes ('EOF', "EOF", \EOF).
  const readDelimiter = (start: number): [string, number] => {
    let i = start;
    let delimiter = "";
    while (i < input.length && !" \t\r\n;&|()<>".includes(input[i]!)) {
      const c = input[i]!;
      if (c === "'" || c === '"') {
        const end = input.indexOf(c, i + 1);
        const stop = end === -1 ? input.length : end;
        delimiter += input.slice(i + 1, stop);
        i = stop + 1;
      } else if (c === "\\") {
        delimiter += input[i + 1] ?? "";
        i += 2;
      } else {
        delimiter += c;
        i++;
      }
    }
    return [delimiter, i];
  };
  // Reads the pending heredoc bodies that start at `start`, one after another.
  const readBodies = (start: number): number => {
    let i = start;
    for (const { token, delimiter, stripTabs } of pending.splice(0)) {
      const lines: string[] = [];
      while (i < input.length) {
        const end = input.indexOf("\n", i);
        const raw = input.slice(i, end === -1 ? input.length : end);
        i = end === -1 ? input.length : end + 1;
        const line = stripTabs ? raw.replace(/^\t+/, "") : raw;
        if (line.replace(/\r$/, "") === delimiter) break;
        lines.push(line);
      }
      token.body = lines.join("\n");
    }
    return i;
  };

  let i = from;
  let n = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      const stop = end === -1 ? input.length : end;
      word += input.slice(i + 1, stop);
      inWord = true;
      quoted = true;
      i = stop + 1;
    } else if (c === '"') {
      inWord = true;
      quoted = true;
      i++;
      while (i < input.length && input[i] !== '"') {
        const d = input[i]!;
        if (d === "\\" && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1]!)) {
          word += input[i + 1];
          i += 2;
        } else if (d === "$" && input[i + 1] === "(") {
          dynamic = true;
          i = readParen(i + 2);
        } else if (d === "`") {
          dynamic = true;
          i = readBacktick(i + 1);
        } else {
          if (d === "$" && expands(i)) dynamic = true;
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
    } else if ("$<>".includes(c) && input[i + 1] === "(") {
      // $(...), or a process substitution <(...) >(...): one argument, joined with any text around it (#156).
      inWord = true;
      dynamic = true;
      i = readParen(i + 2);
    } else if (c === "`") {
      inWord = true;
      dynamic = true;
      i = readBacktick(i + 1);
    } else if (c === "#" && !inWord) {
      // A comment runs to the end of the line.
      while (i < input.length && input[i] !== "\n") i++;
    } else if (c === "<" && input[i + 1] === "<" && input[i + 2] === "<") {
      flush();
      hereString = true;
      i += 3;
    } else if (c === "<" && input[i + 1] === "<") {
      flush();
      i += 2;
      const stripTabs = input[i] === "-";
      if (stripTabs) i++;
      while (input[i] === " " || input[i] === "\t") i++;
      const [delimiter, next] = readDelimiter(i);
      const token = { kind: "stdin" as const, body: "" };
      tokens.push(token);
      pending.push({ token, delimiter, stripTabs });
      i = next;
    } else if ((n = redirection(input, i))) {
      if (!quoted && !dynamic && isStream(input, i, word)) inWord = false;
      flush();
      target = true;
      i += n;
    } else if (" \t\r".includes(c)) {
      flush();
      i++;
    } else if (nested && c === ")" && depth === 0) {
      flush();
      return { tokens, end: i + 1, closed: true };
    } else if (";&|()\n".includes(c)) {
      flush();
      tokens.push({ kind: "op", op: c });
      if (c === "(") depth++;
      if (c === ")") depth--;
      i++;
      if (c === "\n" && pending.length > 0) i = readBodies(i);
    } else {
      if (c === "$" && expands(i)) dynamic = true;
      word += c;
      inWord = true;
      i++;
    }
  }
  flush();
  return { tokens, end: i, closed: false };
}
