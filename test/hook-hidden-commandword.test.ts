import { describe, expect, it } from "vitest";
import { asked, bare, CALL, hook } from "./hook-env-fixture.js";
import { HIDDEN, refused } from "./hook-hidden-fixture.js";

const BASH = "Bash" as const;
const PS = "PowerShell" as const;

// #163. A command word known only when it runs is the same with arguments as without. Run in real Git Bash and Windows
// PowerShell 5.1 with a printer named like the CLI.

describe("bash: a command word known only when it runs, with arguments (#163)", () => {
  refused(BASH, [
    "$CMD CLI",
    "\"$CMD\" CLI",
    "${CMD} CLI",
    "$1 CLI",
    "\"$@\" CLI",
    "$(cat c) CLI",
    "\"$(cat c)\" CLI",
    "`cat c` CLI",
    "$CMD x; CLI",
    "\"$CMD\" x; CLI",
    "$(cat c) x; CLI",
    "$CMD x; echo CLI",
    "$CMD x CLI",
    "$RUN CLI | tee log",
    "X=1 $RUN CLI",
    "env $RUN CLI",
    "nohup $RUN CLI",
    "if true; then $RUN CLI; fi",
    "bash -c '$RUN CLI'",
  ]);

  it.each(["$CMD repo view cli/cli; gh repo view cli/cli", "$CMD x gh", "$CMD gh", "$CMD --hostname other.example; gh pr list"])("%s", async (line) => {
    const stopped = await hook(line, BASH);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(HIDDEN);
    asked.length = 0;
    expect((await hook(line, BASH, {}, bare)).decision).toBe("allow");
    expect(asked).toEqual([]);
  });

  it("a call already read ran before it", async () => {
    expect((await hook("gh repo view cli/cli; $CMD x", BASH)).decision).toBe("allow");
    expect((await hook(`${CALL}; $CMD gh pr list`, BASH)).decision).toBe("deny");
  });

  it("through cloudpin exec too, where the word has no expansions left", async () => {
    expect((await hook("cloudpin exec -- $RUN gh pr list", BASH)).decision).toBe("deny");
    expect((await hook("cloudpin exec -- \"$RUN\"; echo gh pr list", BASH)).decision).toBe("deny");
  });

  it("no CLI named, nothing to stop", async () => {
    for (const line of ["$CMD x", "\"$CMD\" x y", "$(cat c) x", "$RUN deploy | tee log"]) expect((await hook(line, BASH)).decision).toBe("allow");
  });

  it("a word that looks the CLI up runs that CLI, so its arguments are read", async () => {
    for (const lookup of ["\"$(command -v gh)\"", "$(which gh)", "\"$(type -P gh)\""]) {
      expect((await hook(`${lookup} pr list`, BASH)).decision).toBe("allow");
      expect((await hook(`${lookup} --hostname other.example pr list`, BASH)).decision).toBe("deny");
    }
  });

  it("xargs with no command runs echo, not what it reads", async () => {
    expect((await hook(`gh pr list | xargs; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook("x=$(gh pr list | xargs); echo $x", BASH)).decision).toBe("allow");
  });

  it("exempt calls pass", async () => {
    expect((await hook("$CMD --version; gh --version", BASH)).decision).toBe("allow");
    expect((await hook("$RUN gh auth status", BASH)).decision).toBe("allow");
  });

  it("a value the line set is still read", async () => {
    expect((await hook("c=gh; $c --hostname other.example pr list", BASH)).reason).not.toContain(HIDDEN);
    expect((await hook("c=gh; $c --hostname other.example pr list", BASH)).decision).toBe("deny");
    expect((await hook("c=gh; $c pr list", BASH)).decision).toBe("allow");
    expect((await hook("c='gh pr'; $c list", BASH)).decision).toBe("allow");
  });

  it("text around it makes it a path, read no more than ./x.sh", async () => {
    for (const line of ["$D/x.sh a; gh pr list", "\"$D/x.sh\" a; gh pr list", "$(npm bin)/tsc --noEmit; gh pr list"]) expect((await hook(line, BASH)).decision).toBe("allow");
  });

  it("what PowerShell writes, read as bash, is still a value: alone before a pipe, or a test", async () => {
    expect((await hook("$files | ForEach-Object { ls }; echo gh pr list", BASH)).decision).toBe("allow");
    expect((await hook("if ($x) { gh pr list }", BASH)).decision).toBe("allow");
  });
});

describe("PowerShell: & with a word known only when it runs (#163)", () => {
  refused(PS, ["& $c CLI", "& \"$c\" CLI", "& $c x; echo 'CLI'", "& $env:CMD x; echo 'CLI'", "& $args[0] CLI"]);

  it("the rest is as it was", async () => {
    expect((await hook("$c='gh'; & $c --hostname other.example pr list", PS)).decision).toBe("deny");
    expect((await hook("$c='gh'; & $c pr list", PS)).decision).toBe("allow");
    expect((await hook("& $c x", PS)).decision).toBe("allow");
    expect((await hook("$c x; echo 'gh pr list'", PS)).decision).toBe("allow");
    expect((await hook(". $f x; echo gh --version", PS)).decision).toBe("allow");
  });
});
