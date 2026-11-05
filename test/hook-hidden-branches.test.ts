import { describe, expect, it } from "vitest";
import { bare, CALL, followed, hook, NAMED, RIGHT, WRONG } from "./hook-env-fixture.js";

const BASH = "Bash" as const;
const PS = "PowerShell" as const;

// #163. A plain variable set where it may not run is unknown after it, as in PowerShell. Run in real Git Bash with a
// printer named like the CLI.

describe("bash: a plain variable set where it may not run is unknown after it (#163)", () => {
  const HOST = "the value of --hostname";
  const CHECK = "gh --hostname $s pr list";
  const PINNED = "github.com";

  it.each([
    "if false; then s=PIN; fi",
    "if c; then s=PIN; else t=1; fi",
    "if c; then t=1; else s=PIN; fi",
    "if c; then t=1; elif d; then s=PIN; fi",
    "while false; do s=PIN; done",
    "until true; do s=PIN; done",
    "for i in; do s=PIN; done",
    "case x in y) s=PIN;; esac",
    "false && s=PIN",
    "true || s=PIN",
    "false &&\ns=PIN",
    "cd x && s=PIN",
  ])("other.example, then %s", async (shape) => {
    const line = `s=other.example; ${shape.split("PIN").join(PINNED)}; ${CHECK}`;
    const stopped = await hook(line, BASH);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(HOST);
    expect((await hook(line, BASH, {}, bare)).decision).toBe("allow");
  });

  it.each([
    `s=${PINNED}; ${CHECK}`,
    `s=${PINNED}; if c; then s=${PINNED}; fi; ${CHECK}`,
    `s=${PINNED}; c && s=${PINNED}; ${CHECK}`,
    `s=${PINNED}; if c; then t=1; fi; ${CHECK}`,
    `s=x; if c; then s=y; fi; s=${PINNED}; ${CHECK}`,
    `s=x; c && t=y; s=${PINNED}; ${CHECK}`,
    `s=x; { s=${PINNED}; }; ${CHECK}`,
    `s=${PINNED} && ${CHECK}`,
    `if c; then ls; fi; s=${PINNED}; ${CHECK}`,
    `c && ls; s=${PINNED}; ${CHECK}`,
    `for i in 1; do ls; done; s=${PINNED}; ${CHECK}`,
    `case x in y) ls;; esac; s=${PINNED}; ${CHECK}`,
    `until c; do ls; done; s=${PINNED}; ${CHECK}`,
    `"if" x; s=${PINNED}; ${CHECK}`,
  ])("still read: %s", async (line) => {
    expect((await hook(line, BASH)).decision).toBe("allow");
  });

  it("only a value that picks the account stops", async () => {
    expect((await hook("s=a; if c; then s=b; fi; gh pr list $s", BASH)).decision).toBe("allow");
    expect((await hook("s=a; c && s=b; gh pr list \"$s\"", BASH)).decision).toBe("allow");
    expect((await hook("if c; then s=b; fi; gh pr list $s", BASH)).decision).toBe("allow");
    expect((await hook("if c; then FOO=x; fi; gh pr list", BASH)).decision).toBe("allow");
    expect((await hook(`if c; then GH_TOKEN=${WRONG}; fi; gh pr list`, BASH)).decision).toBe("allow");
  });

  it("a value that may be several words or a flag may be a flag", async () => {
    expect((await hook("s=a; if c; then s='--hostname x'; fi; gh pr list $s", BASH)).decision).toBe("deny");
    expect((await hook("s='--hostname x'; if c; then s=a; fi; gh pr list $s", BASH)).decision).toBe("deny");
    expect((await hook("s=a; if c; then s=--hostname; fi; gh pr list $s x", BASH)).decision).toBe("deny");
    expect((await hook("if c; then s=a; fi; s=$(cat f); gh pr list $s", BASH)).decision).toBe("deny");
    expect((await hook("if c; then s='x --hostname y'; fi; gh pr list $s", BASH)).decision).toBe("deny");
  });

  it("one that reaches the CLI, and picks its account", async () => {
    const stopped = await hook(`export GH_TOKEN=a; if c; then GH_TOKEN=${RIGHT}; fi; ${CALL}`, BASH);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(NAMED);
    expect((await hook(`export GH_TOKEN=a; c && GH_TOKEN=${RIGHT}; ${CALL}`, BASH)).decision).toBe("deny");
    expect((await hook(`export FOO=a; if c; then FOO=b; fi; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`if c; then GH_TOKEN=x; fi; ${CALL}`, BASH, { GH_TOKEN: RIGHT })).decision).toBe("deny");
  });

  // Not widened: what a branch exports and where it moves stay read as if they ran.
  followed(BASH, ["false && export GH_TOKEN=VALUE", "if c; then export GH_TOKEN=VALUE; fi"]);

  it("a folder stays read as if the move ran", async () => {
    expect((await hook(`test -d a && cd ${JSON.stringify(bare)}; ${CALL}`, BASH)).decision).toBe("allow");
  });

  it("a line read as PowerShell keeps its own rule, and its literal", async () => {
    expect((await hook(`$s='${PINNED}'; ${CHECK}`, PS)).decision).toBe("allow");
    expect((await hook(`$s='other.example'; if ($c) { $s='${PINNED}' }; ${CHECK}`, PS)).decision).toBe("deny");
  });
});
