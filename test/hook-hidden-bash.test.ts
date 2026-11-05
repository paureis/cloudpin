import { describe, expect, it } from "vitest";
import { asked, bare, CALL, followed, hook, notSet, WRONG } from "./hook-env-fixture.js";
import { HIDDEN, refused } from "./hook-hidden-fixture.js";

const BASH = "Bash" as const;

describe("bash: text piped into a shell (#163)", () => {
  followed(BASH, [
    "echo 'GH_TOKEN=VALUE gh pr list' | bash",
    "echo 'GH_TOKEN=VALUE gh pr list' | sh",
    "echo 'GH_TOKEN=VALUE gh pr list' | dash",
    "echo 'GH_TOKEN=VALUE gh pr list' | bash -s",
    "echo 'GH_TOKEN=VALUE gh pr list' | bash -",
    "echo 'GH_TOKEN=VALUE gh pr list' | bash --",
    "echo 'GH_TOKEN=VALUE gh pr list' | bash /dev/stdin",
    "echo 'GH_TOKEN=VALUE gh pr list' | bash -s -- a b",
    "echo 'GH_TOKEN=VALUE gh pr list' | bash -s script.sh",
    "echo -n 'GH_TOKEN=VALUE gh pr list' | bash",
    "echo GH_TOKEN=VALUE gh pr list | bash",
    "X='GH_TOKEN=VALUE gh pr list'; echo \"$X\" | bash",
    "echo 'GH_TOKEN=VALUE gh pr list' |& bash",
    "echo 'GH_TOKEN=VALUE gh pr list' |\nbash",
    "echo 'GH_TOKEN=VALUE gh pr list' | (bash)",
    "echo 'GH_TOKEN=VALUE gh pr list' | { bash; }",
    "echo 'GH_TOKEN=VALUE gh pr list' | env bash",
    "cat <<X | bash\nGH_TOKEN=VALUE gh pr list\nX",
    "cat <<'X' | sh\nGH_TOKEN=VALUE gh pr list\nX",
    "cat - <<X | bash\nGH_TOKEN=VALUE gh pr list\nX",
    "cat <<< 'GH_TOKEN=VALUE gh pr list' | bash",
    "bash <<< 'GH_TOKEN=VALUE gh pr list'",
    "echo '$env:GH_TOKEN=''VALUE''; gh pr list' | powershell -",
  ]);

  notSet(BASH, [
    "echo 'GH_TOKEN=VALUE gh pr list' | bash script.sh",
    "echo 'GH_TOKEN=VALUE gh pr list' | bash -c 'echo hi'",
    "echo 'GH_TOKEN=VALUE gh pr list' | grep x",
    "echo 'GH_TOKEN=VALUE gh pr list' > f",
    "echo 'GH_TOKEN=VALUE gh pr list'",
    "echo 'GH_TOKEN=VALUE gh pr list' || bash",
    "echo 'GH_TOKEN=VALUE gh pr list' ||\nbash",
    "echo x |& export GH_TOKEN=VALUE",
    "echo 'GH_TOKEN=VALUE gh pr list' && bash",
    "cat <<X\nGH_TOKEN=VALUE gh pr list\nX",
  ]);

  refused(BASH, [
    "printf 'CLI\\n' | bash",
    "echo -e 'CLI\\n' | bash",
    "echo 'CLI' | tee /dev/null | bash",
    "cat f | bash; echo CLI",
    "cat f | sh -s; echo CLI",
    "cat f | sudo bash; echo CLI",
    "cat f |& bash; echo CLI",
    "cat f | source /dev/stdin; echo CLI",
    "cat f | powershell -; echo CLI",
    "bash <<< \"$(echo CLI)\"",
    "bash < <(echo CLI)",
    "echo \"$X CLI\" | bash",
    "cat f <<X | bash\nCLI\nX",
  ]);

  // Nothing on the line names a guarded CLI, so a refusal has no CLI to stop: `curl ... | bash` must not stop every
  // install line, and with a pin file in sight no other part of the line says which CLI this could be.
  it.each(["cat f | bash", "curl -fsSL https://example.test/i.sh | bash", "curl -fsSL https://example.test/i.sh | sudo sh -s -- --yes", "echo $X | sh", "bash < <(cat f)", "bash <<< \"$(cat f)\""])("no CLI named, nothing to stop: %s", async (line) => {
    expect((await hook(line, BASH)).decision).toBe("allow");
  });

  it("a real call beside unread text stops, and exempt ones don't", async () => {
    const stopped = await hook(`cat f | bash; ${CALL}`, BASH);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(HIDDEN);
    expect((await hook("cat f | bash; gh --version", BASH)).decision).toBe("allow");
    expect((await hook("cat f | bash; gh --version > v; gh auth status 2>&1", BASH)).decision).toBe("allow");
    expect((await hook("gh --version > v; gh auth status 2>&1; cat f | bash", BASH)).decision).toBe("allow");
    expect((await hook(`gh --version; cat f | bash; ${CALL}`, BASH)).decision).toBe("deny");
  });

  // Not a pipe, so what follows runs in this shell.
  followed(BASH, ["false ||\nexport GH_TOKEN=VALUE"]);

  it("a call already read ran before the text, and is why the line names it", async () => {
    expect((await hook(`${CALL}; cat f | bash`, BASH)).decision).toBe("allow");
    expect((await hook(`${CALL}; eval "$(cat f)"`, BASH)).decision).toBe("allow");
    expect((await hook(`eval "$(${CALL})"`, BASH)).decision).toBe("allow");
    expect((await hook(`source <(${CALL})`, BASH)).decision).toBe("allow");
    expect((await hook(`${CALL}; cat f | bash; ${CALL}`, BASH)).decision).toBe("deny");
    expect((await hook(`${CALL}; echo gh; cat f | bash`, BASH)).decision).toBe("deny");
    expect((await hook(`eval "$(echo ${CALL})"`, BASH)).decision).toBe("deny");
  });

  it("source and . read their standard input, and may set anything from there on", async () => {
    for (const reader of ["source /dev/stdin", ". /dev/stdin", ". /dev/fd/0"]) {
      expect((await hook(`echo 'GH_TOKEN=${WRONG} gh pr list' | ${reader}`, BASH)).decision).toBe("deny");
      expect((await hook("echo 'gh --version' | " + reader, BASH)).decision).toBe("allow");
      expect((await hook("echo 'ls' | " + reader, BASH)).decision).toBe("allow");
    }
  });

  it("output sent to a process substitution isn't input", async () => {
    expect((await hook("bash > >(tee log); echo gh pr list", BASH)).decision).toBe("allow");
    expect((await hook("bash < <(cat f); echo gh pr list", BASH)).decision).toBe("deny");
  });

  it("a heredoc wins over the pipe, as the shell's redirection does", async () => {
    expect((await hook(`true | bash <<E\ngh pr list\nE`, BASH)).decision).toBe("allow");
    expect((await hook(`cat f | bash <<E\nGH_TOKEN=${WRONG} gh pr list\nE`, BASH)).decision).toBe("deny");
    expect((await hook("cat f | bash <<E\ngh --version\nE", BASH)).decision).toBe("allow");
  });

  it("what PowerShell writes, read as bash, is a value", async () => {
    expect((await hook("$files | ForEach-Object { gh --version }", BASH)).decision).toBe("allow");
    expect((await hook("$files | ForEach-Object { ls }; echo gh pr list", BASH)).decision).toBe("allow");
    expect((await hook("$x | tee f; echo gh pr list", BASH)).decision).toBe("allow");
    expect((await hook("if ($x) { gh pr list }", BASH)).decision).toBe("allow");
    expect((await hook("while ($true) { gh pr list }", BASH)).decision).toBe("allow");
    expect((await hook("($x); echo gh pr list", BASH)).decision).toBe("deny");
    expect((await hook("if $x; then echo gh pr list; fi", BASH)).decision).toBe("deny");
    expect((await hook("$x || echo gh pr list", BASH)).decision).toBe("deny");
    expect((await hook("echo gh pr list | $y", BASH)).decision).toBe("deny");
    // A value here, not in the line a shell runs before the pipe.
    expect((await hook("bash -c '$c' | tee f; echo gh pr list", BASH)).decision).toBe("deny");
  });

  it("the marker for what can't be read doesn't name cloudpin itself", async () => {
    expect((await hook("cat f | bash", BASH)).decision).toBe("allow");
    expect((await hook("cat f | bash; cloudpin switch", BASH)).decision).not.toBe("allow");
  });
});

describe("bash: bash -c reads its options as bash does (#163)", () => {
  followed(BASH, [
    "bash -c -e 'GH_TOKEN=VALUE gh pr list'",
    "bash -c -x 'GH_TOKEN=VALUE gh pr list'",
    "bash -ce 'GH_TOKEN=VALUE gh pr list'",
    "bash -ec 'GH_TOKEN=VALUE gh pr list'",
    "bash -c -- 'GH_TOKEN=VALUE gh pr list'",
    "bash -c - 'GH_TOKEN=VALUE gh pr list'",
    "bash -c -o errexit 'GH_TOKEN=VALUE gh pr list'",
    "bash -co errexit 'GH_TOKEN=VALUE gh pr list'",
    "bash -oc errexit 'GH_TOKEN=VALUE gh pr list'",
    "bash -o errexit -c 'GH_TOKEN=VALUE gh pr list'",
    "bash --norc -c 'GH_TOKEN=VALUE gh pr list'",
    "bash --rcfile /dev/null -c 'GH_TOKEN=VALUE gh pr list'",
    "bash -c -O extglob 'GH_TOKEN=VALUE gh pr list'",
    "bash +x -c 'GH_TOKEN=VALUE gh pr list'",
    "bash +c 'GH_TOKEN=VALUE gh pr list'",
    "bash -c +x 'GH_TOKEN=VALUE gh pr list'",
    "bash -e -c -u 'GH_TOKEN=VALUE gh pr list'",
    "sh -c -e 'GH_TOKEN=VALUE gh pr list'",
    "sh -c -o errexit 'GH_TOKEN=VALUE gh pr list'",
    "dash -c -e 'GH_TOKEN=VALUE gh pr list'",
    "dash -e -c 'GH_TOKEN=VALUE gh pr list'",
    "X='GH_TOKEN=VALUE gh pr list; ls'; bash -c \"$X\"",
    "bash -c -a 'GH_TOKEN=VALUE; gh pr list'",
  ]);

  notSet(BASH, [
    "bash -c 'echo hi' 'GH_TOKEN=VALUE gh pr list'",
    "bash script.sh -c 'GH_TOKEN=VALUE gh pr list'",
    "bash -- script.sh -c 'GH_TOKEN=VALUE gh pr list'",
    "bash \"$D/script.sh\" -x 'GH_TOKEN=VALUE gh pr list'",
    "bash -c",
  ]);

  it("a flag only known when it runs refuses, as the string may be read or not", async () => {
    const stopped = await hook(`bash $F -c '${CALL}'`, BASH);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(HIDDEN);
  });
});

describe("bash: trap runs its string later (#163)", () => {
  followed(BASH, [
    "trap 'GH_TOKEN=VALUE gh pr list' EXIT",
    "trap \"GH_TOKEN=VALUE gh pr list\" EXIT",
    "trap -- 'GH_TOKEN=VALUE gh pr list' EXIT",
    "trap 'GH_TOKEN=VALUE gh pr list' 0",
    "trap 'GH_TOKEN=VALUE gh pr list' INT TERM",
    "X='GH_TOKEN=VALUE gh pr list'; trap \"$X\" EXIT",
    "(trap 'GH_TOKEN=VALUE gh pr list' EXIT)",
    "f() { trap 'GH_TOKEN=VALUE gh pr list' RETURN; }; f",
    // What it sees is what the line left at the end, not where it was written.
    "trap 'gh pr list' EXIT; export GH_TOKEN=VALUE",
    "alias a='GH_TOKEN=VALUE gh'\ntrap 'a pr list' EXIT",
  ]);

  notSet(BASH, [
    "trap -l GH_TOKEN=VALUE",
    "trap -p 'GH_TOKEN=VALUE gh pr list'",
    "trap - 'GH_TOKEN=VALUE gh pr list'",
    "trap 'GH_TOKEN=VALUE gh pr list'",
    "trap '' EXIT; GH_TOKEN=VALUE true",
  ]);

  refused(BASH, ["trap \"$(echo CLI)\" EXIT", "trap \"$X\" EXIT; echo CLI", "trap $X EXIT; echo CLI", "trap \"$(cat f)\" INT; echo CLI"]);

  it("the string changes nothing for what follows it", async () => {
    expect((await hook(`trap 'export GH_TOKEN=${WRONG}' INT; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`trap 'cd ${JSON.stringify(bare)}' EXIT; ${CALL}`, BASH)).decision).toBe("allow");
  });

  it("names the call once when nothing changed before the end", async () => {
    asked.length = 0;
    expect((await hook(`trap '${CALL}' EXIT`, BASH)).decision).toBe("allow");
  });
});

describe("bash: ${x:-...} (#163)", () => {
  followed(BASH, [
    "x=${y:-$(GH_TOKEN=VALUE gh pr list)}",
    "echo \"${y:-$(GH_TOKEN=VALUE gh pr list)}\"",
    "echo ${y:-`GH_TOKEN=VALUE gh pr list`}",
    "x=${y:+$(GH_TOKEN=VALUE gh pr list)}",
    ": ${y:=$(GH_TOKEN=VALUE gh pr list)}",
    "echo ${y:-$(echo $(GH_TOKEN=VALUE gh pr list))}",
    "echo ${y:-$(echo '}' $(GH_TOKEN=VALUE gh pr list))}",
    "GH_TOKEN=VALUE ${CLI:-gh} pr list",
    "GH_TOKEN=VALUE \"${CLI:-gh}\" pr list",
    "GH_TOKEN=VALUE ${CLI-gh} pr list",
    "GH_TOKEN=VALUE ${CLI:=gh} pr list",
    "GH_TOKEN=VALUE ${CLI:+gh} pr list",
  ]);

  it("only as a command word, alone", async () => {
    const stopped = await hook("${CLI:-gh}", BASH);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(HIDDEN);
    expect((await hook("\"${CLI:-gh}\"", BASH)).decision).toBe("deny");
    expect((await hook("${CLI:-gh}", BASH, {}, bare)).decision).toBe("allow");
    expect((await hook("${CLI:-gh} --version", BASH)).decision).toBe("allow");
    expect((await hook("${CLI:-ls}", BASH)).decision).toBe("allow");
    expect((await hook("${CLI:-ls-gh}", BASH)).decision).toBe("allow");
    expect((await hook("echo ${CLI:-gh}", BASH)).decision).toBe("allow");
  });

  it("the words around one are still read", async () => {
    expect((await hook(`x=\${y:-z}; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook("x=${#y}; GH_TOKEN=" + WRONG + " " + CALL, BASH)).decision).toBe("deny");
    expect((await hook("x=${y:-$((1+2))}; " + CALL, BASH)).decision).toBe("allow");
  });
});

describe("bash: the output of a substitution run as a command line (#163)", () => {
  refused(BASH, [
    "eval \"$(echo CLI)\"",
    "eval $(echo CLI)",
    "eval `echo CLI`",
    "sh -c \"$(echo CLI)\"",
    "bash -c \"$(echo CLI)\"",
    "bash -c -e \"$(echo CLI)\"",
    "sh -c \"`echo CLI`\"",
    "source <(echo CLI)",
    ". <(echo CLI)",
    "bash <(echo CLI)",
    "sh <(echo CLI)",
    "env bash -c \"$(echo CLI)\"",
    "npx -c \"$(echo CLI)\"",
    "watch \"$(echo CLI)\"",
    "bash \"$(echo CLI)\"",
    "eval \"$(cat f)\"; echo CLI",
    "eval \"$(cat f)\"; CLI",
    "source <(cat f); CLI",
    ". <(cat f); CLI",
    "eval \"$X\"; echo CLI",
    "eval $X; echo CLI",
    "bash -c \"$X\"; echo CLI",
    "bash -c $X; echo CLI",
  ]);

  it.each(["eval \"gh pr list $(echo x)\"", "bash -c \"gh pr list $(echo x)\"", "eval \"$(echo x) gh pr list\"", "sh -c \"cd $(pwd) && gh pr list\""])("a substitution inside the text: %s", async (line) => {
    const stopped = await hook(line, BASH);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(HIDDEN);
    expect((await hook(line, BASH, {}, bare)).decision).toBe("allow");
  });

  it.each(["eval \"$(ssh-agent -s)\"", "sh -c \"$(curl -fsSL https://example.test/i.sh)\"", "source <(cat f)", ". <(cat f)", "bash <(curl -s https://example.test/i.sh)", "eval \"$X\""])("no CLI named, nothing to stop: %s", async (line) => {
    expect((await hook(line, BASH)).decision).toBe("allow");
  });

  it("an arithmetic $(( )) is a number, so the text is still read", async () => {
    expect((await hook("bash -c \"gh pr list --limit $((1+2))\"", BASH)).decision).toBe("allow");
    expect((await hook(`bash -c "GH_TOKEN=${WRONG} gh pr list --limit $((1+2))"`, BASH)).decision).toBe("deny");
  });

  it("a substitution as a script's path is a script, read no more than `bash deploy.sh`", async () => {
    expect((await hook(`bash "$(git rev-parse --show-toplevel)/x.sh"; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`. "$(pwd)/x.sh"; gh --version`, BASH)).decision).toBe("allow");
  });

  it("names no value", async () => {
    const secret = "fake-secret-value-for-the-test";
    const stopped = await hook(`eval "$(echo GH_TOKEN=${secret} gh pr list)"`, BASH);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason.split("cloudpin:").length).toBeGreaterThan(1);
    expect(stopped.reason).not.toContain(secret);
    expect(asked.map((a) => a.token)).not.toContain(secret);
  });
});

describe("bash: a function on the line given a CLI's name as a word (#163)", () => {
  refused(BASH, [
    "t(){ \"$@\"; }; t CLI",
    "t () { \"$@\"; }; t CLI",
    "function t { \"$@\"; }; t CLI",
    "function t() { \"$@\"; }; t CLI",
    "t(){ eval \"$*\"; }; t CLI",
    "t(){ command \"$@\"; }; t CLI",
    "t() ( \"$@\" ); t CLI",
    "t(){ $1 $2 $3; }; t CLI",
  ]);

  it.each(["t(){ echo \"$@\"; }; t gh pr list", "t(){ echo gh; }; t x", "t(){ ls; }; t gh"])("a function that doesn't run its words: %s", async (line) => {
    expect((await hook(line, BASH)).decision).toBe("allow");
  });

  it("a function that runs its words, on a line that gives it no CLI", async () => {
    expect((await hook("t(){ \"$@\"; }; t ls -l", BASH)).decision).toBe("allow");
  });
});

describe("bash: a bare $c, whose value the line can't say (#163)", () => {
  refused(BASH, [
    "for c in 'CLI'; do $c; done",
    "for c in 'CLI'; do \"$c\"; done",
    "$(echo CLI)",
    "`echo CLI`",
    "\"$(echo CLI)\"",
    "$X; echo CLI",
    "\"$X\"; echo CLI",
    "${X}; echo CLI",
    "$1; echo CLI",
    "\"$@\"; echo CLI",
    "X=1 $c; echo CLI",
    "if true; then $c; fi; echo CLI",
    "bash <<<\"\\$c\"; echo CLI",
    "bash <<E\n$c\nE\necho CLI",
  ]);

  followed(BASH, [
    "c='gh pr list'; GH_TOKEN=VALUE $c",
    "c=gh; GH_TOKEN=VALUE \"$c\" pr list",
    "c='gh pr list'; GH_TOKEN=VALUE ${c}",
  ]);

  notSet(BASH, [
    "c='GH_TOKEN=VALUE gh pr list'; \"$c\"",
    "c=ls; $c GH_TOKEN=VALUE",
    "c=; $c GH_TOKEN=VALUE",
  ]);

  it.each(["\"$D/x.sh\"; echo gh pr list", "$D/x.sh; echo gh pr list", "$(npm bin)/tsc; echo gh pr list", "\"$(git rev-parse --show-toplevel)/x.sh\"; echo gh pr list"])("text around it makes it a path, read no more than ./x.sh: %s", async (line) => {
    expect((await hook(line, BASH)).decision).toBe("allow");
  });

  it("no CLI named, nothing to stop", async () => {
    expect((await hook("$X", BASH)).decision).toBe("allow");
    expect((await hook("\"$X\"; ls", BASH)).decision).toBe("allow");
    expect((await hook("$(cat f)", BASH)).decision).toBe("allow");
  });
});

describe("bash: aliases reach the lines after theirs (#163)", () => {
  followed(BASH, [
    "alias a=gh\nGH_TOKEN=VALUE a pr list",
    "alias a=gh\na --version\nGH_TOKEN=VALUE a pr list",
    "shopt -s expand_aliases\nalias a=gh\nGH_TOKEN=VALUE a pr list",
    "alias a='gh pr'\nGH_TOKEN=VALUE a list",
    "alias x=ls a=gh\nGH_TOKEN=VALUE a pr list",
    "X=gh\nalias a=\"$X\"\nGH_TOKEN=VALUE a pr list",
    "alias a=gh\n(GH_TOKEN=VALUE a pr list)",
    "alias a=gh\necho $(GH_TOKEN=VALUE a pr list)",
    "alias a=gh; eval 'GH_TOKEN=VALUE a pr list'",
    "alias a=gh\nls; GH_TOKEN=VALUE a pr list",
    "alias a=gh\nalias b=a\nGH_TOKEN=VALUE b pr list",
    "alias a='GH_TOKEN=VALUE gh'\na pr list",
  ]);

  // bash reads a whole line before it runs any of it (bash(1), ALIASES), and a child shell doesn't get them.
  notSet(BASH, [
    "alias a=gh; GH_TOKEN=VALUE a pr list",
    "shopt -s expand_aliases; alias a=gh; GH_TOKEN=VALUE a pr list",
    "alias a=gh\nGH_TOKEN=VALUE \"a\" pr list",
    "alias a=gh\nunalias a\nGH_TOKEN=VALUE a pr list",
    "alias a=gh\nunalias -a\nGH_TOKEN=VALUE a pr list",
    "alias a=gh\nbash -c 'GH_TOKEN=VALUE a pr list'",
    "alias a=ls\nGH_TOKEN=VALUE a pr list",
    "alias -p GH_TOKEN=VALUE",
  ]);

  refused(BASH, [
    "alias a=\"$X\"\na x; echo CLI",
    "alias a=$(cat f)\na x; echo CLI",
    "alias \"$N=CLI\"",
    "alias a='CLI; ls'\na",
  ]);

  it("an alias of itself ends", async () => {
    expect((await hook("alias a=a\na x", BASH)).decision).toBe("allow");
    expect((await hook("alias a=b\nalias b=a\na x", BASH)).decision).toBe("allow");
    const wrong = await hook(`alias gh='GH_TOKEN=${WRONG} gh'\ngh pr list`, BASH);
    expect(wrong.decision).toBe("deny");
    expect(wrong.reason).toContain("someone-else");
  });
});

describe("bash: a line PowerShell would read, read as bash (#163)", () => {
  it("what can't be read stays unknown, with $( ) now in its word", async () => {
    const stopped = await hook(`$env:GH_TOKEN=$(cat f); ${CALL}`, BASH);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain("GH_TOKEN is set by the command line");
  });
});

describe("bash: limits the design note leaves, not read (#163)", () => {
  it.each([
    "node -e \"require('child_process').execSync('gh pr list')\"",
    "git -c alias.x='!gh pr list' x",
    "echo 'gh pr list' > s.sh; bash s.sh",
    "bash deploy.sh",
    "A=g; B=h; echo $A$B",
    `for GH_TOKEN in ${WRONG}; do gh pr list; done`,
  ])("%s", async (line) => {
    expect((await hook(line, BASH)).decision).toBe("allow");
  });
});
