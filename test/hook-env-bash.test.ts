import { describe, expect, it } from "vitest";
import { asked, CALL, followed, hook, NAMED, notSet, pinned, refused, refusedByName, RIGHT, WRONG } from "./hook-env-fixture.js";

const BASH = "Bash" as const;

describe("bash: set -a and set -o allexport export what follows (#163)", () => {
  followed(BASH, [
    "set -a; GH_TOKEN=VALUE",
    "set -o allexport; GH_TOKEN=VALUE",
    "set -ae; GH_TOKEN=VALUE",
    "set -ea; GH_TOKEN=VALUE",
    "set -a -e; GH_TOKEN=VALUE",
    "set -e -a; GH_TOKEN=VALUE",
    "set -eo allexport; GH_TOKEN=VALUE",
    "set -oa allexport; GH_TOKEN=VALUE",
    "set -euao pipefail; GH_TOKEN=VALUE",
    "V=-a; set $V; GH_TOKEN=VALUE",
    "set -a; declare GH_TOKEN=VALUE",
    "set -a; f(){ local GH_TOKEN=VALUE; gh pr list; }; f",
    "set -a; GH_TOKEN=VALUE; set +a",
    "(set -a; GH_TOKEN=VALUE; gh pr list)",
    "set -a; (GH_TOKEN=VALUE; gh pr list)",
    "bash -a -c 'GH_TOKEN=VALUE; gh pr list'",
    "bash -ac 'GH_TOKEN=VALUE; gh pr list'",
    "sh -a -c 'GH_TOKEN=VALUE; gh pr list'",
    "bash -o allexport -c 'GH_TOKEN=VALUE; gh pr list'",
  ]);

  notSet(BASH, [
    "GH_TOKEN=VALUE",
    "GH_TOKEN=VALUE; set -a",
    "set +a; GH_TOKEN=VALUE",
    "set -a; set +a; GH_TOKEN=VALUE",
    "set -a; set +o allexport; GH_TOKEN=VALUE",
    "set -- -a; GH_TOKEN=VALUE",
    "set x -a; GH_TOKEN=VALUE",
    "set - -a; GH_TOKEN=VALUE",
    "set -e; GH_TOKEN=VALUE",
    "set -euo pipefail; GH_TOKEN=VALUE",
    "set -o pipefail; GH_TOKEN=VALUE",
    "(set -a); GH_TOKEN=VALUE",
    "(set -a; GH_TOKEN=VALUE)",
    "set -a | cat; GH_TOKEN=VALUE",
    "set -a & GH_TOKEN=VALUE",
    "set -a; GH_TOKEN=VALUE true",
    "bash -c 'set -a'; GH_TOKEN=VALUE",
    "bash -a -c 'GH_TOKEN=VALUE'",
    "bash -c 'GH_TOKEN=VALUE; gh pr list'",
    "bash -c 'GH_TOKEN=VALUE; gh pr list' -a",
    "(export GH_TOKEN); GH_TOKEN=VALUE",
    "export GH_TOKEN; export -n GH_TOKEN; GH_TOKEN=VALUE",
  ]);

  it("a set -a only the shell can read refuses what follows", async () => {
    expect((await hook(`set $V; ${CALL}`, BASH)).decision).toBe("deny");
    expect((await hook(`set -$(cat f); ${CALL}`, BASH)).decision).toBe("deny");
    expect((await hook(`set -o $V; ${CALL}`, BASH)).decision).toBe("deny");
    expect((await hook(`set -- $V; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`set "$(cat f)"; ${CALL}`, BASH)).decision).toBe("allow");
  });

  it("a dynamic value through set -a stops only the variable that picks the account (#160)", async () => {
    const stopped = await hook(`set -a; GH_TOKEN=$(cat f); ${CALL}`, BASH);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(NAMED);
    expect((await hook(`set -a; FOO=$(cat f); ${CALL}`, BASH)).decision).toBe("allow");
  });
});

describe("bash: export X+=y and the other assignments (#163)", () => {
  followed(BASH, [
    "export GH_TOKEN+=VALUE",
    "GH_TOKEN=a; export GH_TOKEN+=VALUE",
    "export GH_TOKEN=a; GH_TOKEN+=VALUE",
    "GH_TOKEN+=VALUE gh pr list",
    "declare -x GH_TOKEN+=VALUE",
    "typeset -x GH_TOKEN+=VALUE",
    "N=VALUE; export GH_TOKEN+=$N",
    "N=GH_TOKEN; export $N=VALUE",
    "V=GH_TOKEN=VALUE; export $V",
    'V=GH_TOKEN=VALUE; export "$V"',
    "export GH_TOKEN; GH_TOKEN=VALUE",
    "V=GH_TOKEN; GH_TOKEN=VALUE; export $V",
    "declare -x GH_TOKEN; GH_TOKEN=VALUE",
    "f(){ local -x GH_TOKEN=VALUE; gh pr list; }; f",
    "f(){ local -rx GH_TOKEN=VALUE; gh pr list; }; f",
    "f(){ local -xr GH_TOKEN=VALUE; gh pr list; }; f",
    "f(){ local -x GH_TOKEN+=VALUE; gh pr list; }; f",
    "f(){ local -x GH_TOKEN; GH_TOKEN=VALUE; gh pr list; }; f",
    "f(){ local GH_TOKEN=VALUE; export GH_TOKEN; gh pr list; }; f",
    "readonly GH_TOKEN=VALUE; export GH_TOKEN",
  ]);

  it("+= adds to what the variable holds, from the line or the hook's environment", async () => {
    const value = async (line: string, env: NodeJS.ProcessEnv = {}) => {
      asked.length = 0;
      await hook(`${line}; ${CALL}`, BASH, env);
      return asked[0]?.token;
    };
    expect(await value("export GH_TOKEN+=b")).toBe("b");
    expect(await value("export GH_TOKEN+=b", { GH_TOKEN: "a" })).toBe("ab");
    expect(await value("GH_TOKEN+=b", { GH_TOKEN: "a" })).toBe("ab");
    expect(await value("GH_TOKEN=c; export GH_TOKEN+=b", { GH_TOKEN: "a" })).toBe("cb");
    expect(await value("unset GH_TOKEN; export GH_TOKEN+=b", { GH_TOKEN: "a" })).toBe("b");
    expect(await value("GH_TOKEN+=b gh pr list; true", { GH_TOKEN: "a" })).toBe("ab");
    expect(await value("N=b; export GH_TOKEN+=$N")).toBe("b");
    expect(await value("V=GH_TOKEN+=b; export $V", { GH_TOKEN: "a" })).toBe("ab");
    // Plain, and never exported: it doesn't reach the CLI.
    expect(await value("GH_TOKEN+=b")).toBeUndefined();
  });

  it("a part cloudpin can't read makes the whole value unknown (#160)", async () => {
    for (const line of [`export GH_TOKEN+=$(cat f); ${CALL}`, `GH_TOKEN=$(cat f); export GH_TOKEN+=b; ${CALL}`, `GH_TOKEN+=$X ${CALL}`, `GH_TOKEN+=$(cat f) ${CALL}`]) {
      const stopped = await hook(line, BASH);
      expect(stopped.decision, line).toBe("deny");
      expect(stopped.reason, line).toContain(NAMED);
    }
    expect((await hook(`export FOO+=$(cat f); ${CALL}`, BASH)).decision).toBe("allow");
  });

  it("an assignment to a name already exported updates it, whichever builtin wrote it", async () => {
    for (const line of [`declare GH_TOKEN=${WRONG}`, `typeset GH_TOKEN=${WRONG}`, `readonly GH_TOKEN=${WRONG}`, `f(){ local GH_TOKEN=${WRONG}; ${CALL}; }; f`]) {
      const full = line.includes(CALL) ? line : `${line}; ${CALL}`;
      expect((await hook(full, BASH, { GH_TOKEN: RIGHT })).decision, line).toBe("deny");
      expect((await hook(full, BASH)).decision, line).toBe("allow");
    }
  });

  it("readonly has no -x, and an error leaves the variable as it was", async () => {
    expect((await hook(`readonly -x GH_TOKEN=${WRONG}; ${CALL}`, BASH, { GH_TOKEN: RIGHT })).decision).toBe("allow");
  });

  it("a local variable is gone after its function, and what it was isn't read again", async () => {
    const after = await hook(`f(){ local -x GH_TOKEN=${RIGHT}; ${CALL}; }; f; ${CALL}`, BASH);
    expect(after.decision).toBe("deny");
    expect(after.reason).toContain(NAMED);
    expect((await hook(`f(){ local -x FOO=${WRONG}; ${CALL}; }; f; ${CALL}`, BASH)).decision).toBe("allow");
    // Only its own function's end, once, and not a local of a subshell.
    expect((await hook(`f(){ local -x GH_TOKEN=x; }; export GH_TOKEN=${RIGHT}; { true; }; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`export GH_TOKEN=${RIGHT}; f(){ (local -x GH_TOKEN=x); }; ${CALL}`, BASH)).decision).toBe("allow");
  });

  it("export -n and declare +x take the variable from the commands", async () => {
    const env = { GH_TOKEN: WRONG };
    expect((await hook(CALL, BASH, env)).decision).toBe("deny");
    expect((await hook(`export -n GH_TOKEN; ${CALL}`, BASH, env)).decision).toBe("allow");
    expect((await hook(`declare +x GH_TOKEN; ${CALL}`, BASH, env)).decision).toBe("allow");
    expect((await hook(`typeset +x GH_TOKEN; ${CALL}`, BASH, env)).decision).toBe("allow");
    expect((await hook(`(export -n GH_TOKEN); ${CALL}`, BASH, env)).decision).toBe("deny");
    expect((await hook(`export -n GH_TOKEN; export GH_TOKEN; ${CALL}`, BASH, env)).decision).toBe("deny");
    expect((await hook(`export GH_TOKEN=${WRONG}; export -n GH_TOKEN; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`export -n FOO; ${CALL}`, BASH, env)).decision).toBe("deny");
    expect((await hook(`export -n GH_TOKEN=x; ${CALL}`, BASH, env)).decision).toBe("allow");
  });

  it("export -p, -f and declare -p, -f set nothing, whatever follows", async () => {
    for (const line of ["export -p", "export -f f", "declare -p GH_TOKEN", 'declare -p "$V"', "declare -f $V", "declare -F"]) {
      expect((await hook(`${line}; ${CALL}`, BASH)).decision, line).toBe("allow");
    }
  });
});

describe("bash: what only the shell can read makes later calls can't tell (#163)", () => {
  refused(BASH, [
    ". f",
    "source f",
    ". ./f",
    'source "$F"',
    'source "$(cat f)"',
    "source <(cat f)",
    "command . f",
    "builtin source f",
    "{ . f; }",
    "true && . f",
    "if [ -f f ]; then . f; fi",
    "set -a; . f; set +a",
    "S=source; $S f",
    "export $(cat f)",
    'export "$(cat f)"',
    "export $(cat f | xargs)",
    "export `cat f`",
    "export $V",
    'export "$V"',
    "export $V=x",
    "export ${V:-FOO}=x",
    "export FOO$V=x",
    "declare -x $V",
    'declare "$V"',
    'typeset "$V"',
    'readonly "$V"',
    'f(){ local "$V"; }',
    "read $V",
    'read "$V"',
    "read -r $V",
    "set $V",
    'set "$@"',
  ]);

  it("refuses inside the same subshell, not outside it", async () => {
    expect((await hook(`(. f; ${CALL})`, BASH)).decision).toBe("deny");
    expect((await hook(`(. f); ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`. f; (${CALL})`, BASH)).decision).toBe("deny");
    expect((await hook(`echo "$(. f)"; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`. f | cat; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`echo | . f; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`. f & ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`bash -c '. f'; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`bash -c '. f; ${CALL}'`, BASH)).decision).toBe("deny");
    expect((await hook(`. f; bash -c '${CALL}'`, BASH)).decision).toBe("deny");
    expect((await hook(`eval '. f'; ${CALL}`, BASH)).decision).toBe("deny");
  });

  it("env -i leaves only what its own line gives the call", async () => {
    expect((await hook(`. f; env -i ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`. f; env -i GH_TOKEN=${WRONG} ${CALL}`, BASH)).decision).toBe("deny");
    expect((await hook(`. f; env FOO=1 ${CALL}`, BASH)).decision).toBe("deny");
  });

  it("source is only a word elsewhere, and PowerShell has no source", async () => {
    expect((await hook(`echo source f; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`echo . f; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`"source"; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`source; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`source f; ${CALL}`, "PowerShell")).decision).toBe("allow");
    expect((await hook(`set -a; GH_TOKEN=${WRONG}; ${CALL}`, "PowerShell")).decision).toBe("allow");
  });
});

describe("bash: read names what it sets (#163)", () => {
  refusedByName(BASH, [
    "read NAME",
    "read -r NAME",
    "read -s NAME",
    "read -p prompt NAME",
    "read -pprompt NAME",
    "read -t 1 NAME",
    "read -d x NAME",
    "read -n 3 NAME",
    "read -u 3 NAME",
    "read -r -p prompt -t 1 NAME",
    "read -- NAME",
    "read -ra NAME",
    "read -a NAME",
    "read A NAME B",
    "V=NAME; read $V",
    "while read NAME; do gh pr list; done < f",
    "cat f | while read NAME; do gh pr list; done",
  ], { GH_TOKEN: RIGHT, FOO: "x" });

  refusedByName(BASH, ["read NAME; export NAME", "export NAME; read NAME", "set -a; read NAME", "declare -x NAME; read NAME"]);

  it("a name not exported doesn't reach the CLI", async () => {
    expect((await hook(`read GH_TOKEN; ${CALL}`, BASH)).decision).toBe("allow");
    expect((await hook(`read -r GH_TOKEN; ${CALL}`, BASH)).decision).toBe("allow");
  });

  it("the flag's value is not the name", async () => {
    const env = { GH_TOKEN: RIGHT };
    for (const line of ["read -p GH_TOKEN", "read -r -p GH_TOKEN FOO", "read -t 1", "read -d GH_TOKEN FOO", "read", "read -r", "read -a FOO", "read -ra FOO", "read FOO BAR"]) {
      expect((await hook(`${line}; ${CALL}`, BASH, env)).decision, line).toBe("allow");
    }
  });

  it("a pipe's side and a subshell don't carry it", async () => {
    const env = { GH_TOKEN: RIGHT };
    expect((await hook(`echo x | read GH_TOKEN; ${CALL}`, BASH, env)).decision).toBe("allow");
    expect((await hook(`read GH_TOKEN | cat; ${CALL}`, BASH, env)).decision).toBe("allow");
    expect((await hook(`(read GH_TOKEN); ${CALL}`, BASH, env)).decision).toBe("allow");
    expect((await hook(`(read GH_TOKEN; ${CALL})`, BASH, env)).decision).toBe("deny");
  });
});

describe("bash: a subshell, a pipe and a job scope what they set (#163)", () => {
  notSet(BASH, [
    "(export GH_TOKEN=VALUE)",
    "export GH_TOKEN=VALUE | cat",
    "cat f | export GH_TOKEN=VALUE",
    "export GH_TOKEN=VALUE & true",
    'echo "$(export GH_TOKEN=VALUE)"',
    "bash -c 'export GH_TOKEN=VALUE'",
  ]);

  followed(BASH, ["{ export GH_TOKEN=VALUE; }", "(export GH_TOKEN=VALUE; gh pr list)", "true && export GH_TOKEN=VALUE"]);

  it("a pipe's side keeps what was set before it", async () => {
    expect((await hook(`export GH_TOKEN=${WRONG}; export FOO=1 | cat; ${CALL}`, BASH)).decision).toBe("deny");
    expect((await hook(`export GH_TOKEN=${WRONG} && echo x | cat; ${CALL}`, BASH)).decision).toBe("deny");
  });
});

describe("bash: a name that picks nothing keeps passing (#163)", () => {
  it.each(["export FOO=1", "export FOO+=1", "export FOO=$(cat f)", "set -a; FOO=1", "set -a; FOO=$(cat f)", "read FOO", "FOO+=1", "declare FOO=1", "f(){ local -x FOO=1; }; f"])("%s", async (line) => {
    expect((await hook(`${line}; ${CALL}`, BASH, { GH_TOKEN: RIGHT })).decision).toBe("allow");
  });

  it("control: the same pin and the wrong token denies, in this folder", async () => {
    expect((await hook(`export GH_TOKEN=${WRONG}; ${CALL}`, BASH, {}, pinned)).decision).toBe("deny");
  });
});
