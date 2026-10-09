import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findInvocations } from "../src/shellwords.js";

// Property-based tests: fast-check generates the inputs, and shrinks any
// failure to the smallest command line that breaks a property.
const GUARDED = ["az", "aws", "gcloud", "vercel", "gh", "kubectl", "helm"];

// Characters the tokenizer treats specially, so random lines hit its edge
// cases (unclosed quotes, heredocs without bodies, stray operators).
const SHELL_CHARS = [..." \t\r\n;&|()<>'\"`\\$#{}=-~*", "gh", "az", "bash", "-c", "EOF", "<<", "$(", "a", "1"];
const shellish = fc.array(fc.constantFrom(...SHELL_CHARS), { maxLength: 60 }).map((parts) => parts.join(""));

// Commands that are not guarded and run nothing else.
const noise = fc.constantFrom("true", "echo hi", "ls -la", "git status", "npm test", ": x");

/** Single-quotes a string for a POSIX shell: ' becomes '\''. */
const quote = (s: string) => `'${s.split("'").join("'\\''")}'`;

// Ways a command line can run `call`. Each keeps it a real, reachable call. A
// newline goes before anything that follows the call, because a heredoc's
// closing delimiter must be alone on its line. `depth` keeps heredoc delimiters
// unique when they nest.
type Wrap = (call: string, depth: number, other: string) => string | null;
const WRAPS: Record<string, Wrap> = {
  after: (c, _d, o) => `${o}; ${c}`,
  and: (c, _d, o) => `${o} && ${c}`,
  or: (c, _d, o) => `${o} || ${c}`,
  pipe: (c, _d, o) => `${o} | ${c}`,
  background: (c, _d, o) => `${o} & ${c}`,
  before: (c, _d, o) => `${c}\n${o}`,
  subshell: (c) => `(${c}\n)`,
  substitution: (c) => `echo $(${c}\n)`,
  backticks: (c) => (c.includes("`") ? null : "echo `" + c + "\n`"),
  bashC: (c) => `bash -c ${quote(c + "\n")}`,
  heredoc: (c, d) => `bash <<E${d}\n${c}\nE${d}`,
  ifThen: (c) => `if true; then ${c}\nfi`,
  sudo: (c) => (/^[a-z]/.test(c) ? `sudo ${c}` : null),
  envVar: (c) => (/^[a-z]/.test(c) ? `CLOUDPIN_FUZZ=1 ${c}` : null),
  timeout: (c) => (/^[a-z]/.test(c) ? `timeout 5 ${c}` : null),
  comment: (c, _d, o) => `# ${o} && not a call\n${c}`,
};

const call = fc.record({
  bin: fc.constantFrom(...GUARDED),
  args: fc.array(fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,7}$/), { maxLength: 4 }),
});
const wrapping = fc.array(fc.tuple(fc.constantFrom(...Object.keys(WRAPS)), noise), { maxLength: 6 });

describe("findInvocations (fuzzed)", () => {
  it("never throws, whatever the command line", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: "binary", maxLength: 200 }), shellish), (line) => {
        findInvocations(line, GUARDED, "/work");
      }),
      { numRuns: 2000 },
    );
  });

  it("finds a guarded call however the line wraps it, and nothing else", () => {
    fc.assert(
      fc.property(call, wrapping, ({ bin, args }, wraps) => {
        let line = [bin, ...args].join(" ");
        wraps.forEach(([name, other], depth) => {
          line = WRAPS[name]!(line, depth, other) ?? line;
        });
        const found = findInvocations(line, GUARDED).map((i) => ({ bin: i.bin, args: i.args }));
        expect(found, line).toEqual([{ bin, args }]);
      }),
      { numRuns: 1000 },
    );
  });
});
