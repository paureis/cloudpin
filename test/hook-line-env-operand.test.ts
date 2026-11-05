import { describe, expect, it } from "vitest";
import { findInvocations } from "../src/shellwords.js";
import { calls, hook, PIN_SUB, WRONG_TOKEN } from "./hook-line-env-fixture.js";

// env(1) takes every word holding = before the command as a variable, whatever its name (GNU env.c: strchr for =;
// BSD env(1) the same), so a name that is no shell identifier is no reason to lose the call. Checked with Git Bash's
// env and a printer: `env 'ZZC^=1' printer` runs the printer with ZZC^ set.
describe("env with a name that is no identifier", () => {
  it.each([
    `env 'ZZC^=1' az group list --subscription other`,
    `env 'a.b=1' az group list --subscription other`,
    `env 'a b=1' az group list --subscription other`,
    `env 'a-b=1' az group list --subscription other`,
    `env 'ZZC^=' az group list --subscription other`,
    `env A=1 'ZZC^=1' B=2 az group list --subscription other`,
    `env 'ZZC^=1' env 'ZZD^=2' az group list --subscription other`,
    `env -i 'ZZC^=1' az group list --subscription other`,
    `env -u FOO 'ZZC^=1' az group list --subscription other`,
    `nice env 'ZZC^=1' az group list --subscription other`,
    `bash -c "env 'ZZC^=1' az group list --subscription other"`,
    `FOO=1 env 'ZZC^=1' az group list --subscription other`,
  ])("follows %j to the call: a wrong account denies, after a lookup", async (line) => {
    const answer = await hook(line);
    expect(answer.decision).toBe("deny");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.bin).toBe("az");
  });

  it("the same line on the pinned account passes, as a control", async () => {
    expect((await hook(`env 'ZZC^=1' az group list --subscription ${PIN_SUB}`)).decision).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("the lookup gets the variable, as the command will", async () => {
    await hook(`env 'ZZC^=1' gh pr list`);
    expect(calls[0]!.env["ZZC^"]).toBe("1");
    expect(findInvocations(`env 'ZZC^=a=b' gh pr list`, ["gh"])[0]!.env).toEqual({ "ZZC^": "a=b" });
  });

  it("a variable that picks the account still counts after one", async () => {
    expect((await hook(`env 'ZZC^=1' GH_TOKEN=${WRONG_TOKEN} gh pr list`)).decision).toBe("deny");
  });

  it("a bash function exported that way runs in any bash script a CLI is: stops, starting nothing", async () => {
    const stopped = await hook(`env 'BASH_FUNC_uname%%=() { x; }' gh pr list`);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain("BASH_FUNC_uname%%");
    expect(calls).toEqual([]);
  });

  it("a value only known when it runs is unknown, and doesn't lose the call", async () => {
    expect((await hook(`env A=1 "ZZC^=$(cat f)" az group list --subscription other`)).decision).toBe("deny");
    expect(calls).toHaveLength(1);
    expect((await hook(`env A=1 "ZZC^=$X" gh pr list`)).decision).toBe("allow");
    expect(calls).toHaveLength(1);
    // Right after env, where a flag may be, any such word can't tell, as it always did.
    expect((await hook(`env "ZZC^=$X" gh pr list`)).decision).toBe("deny");
    expect(calls).toEqual([]);
  });

  it("a name only known when it runs can't tell", async () => {
    const stopped = await hook(`env "$N^=1" gh pr list`);
    expect(stopped.decision).toBe("deny");
    expect(calls).toEqual([]);
  });

  it("a name with a part only known when it runs can't tell, written as an identifier too", async () => {
    for (const line of [`env "$N=1" gh pr list`, `env A=1 "$N=1" gh pr list`, `env A=1 "B$N=1" gh pr list`, `env A=1 "$N" gh pr list`, `env A=1 "B$N" gh pr list`, `env A=1 B$N gh pr list`, `env A=1 "$(x)=1" gh pr list`]) {
      expect((await hook(line)).decision).toBe("deny");
      expect(calls).toEqual([]);
    }
  });

  it("a path to a command with a folder only known when it runs is still that command", async () => {
    for (const line of [`env A=1 "$DIR/gh" pr list`, `sudo A=1 "$DIR/gh" pr list`]) {
      expect((await hook(line)).decision).toBe("allow");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.bin).toBe("gh");
    }
  });

  it("an empty name doesn't lose the call: Git Bash's env runs the command, a stricter one fails on its own", async () => {
    expect((await hook(`env =x az group list --subscription other`)).decision).toBe("deny");
    expect(calls).toHaveLength(1);
  });

  // sudo's parse_args.c: is_envar, any word with = that doesn't start with /. From its source: no sudo here.
  it("sudo takes such a word as a variable too", async () => {
    expect((await hook(`sudo 'ZZC^=1' az group list --subscription other`)).decision).toBe("deny");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env["ZZC^"]).toBe("1");
    // A path is a command, for sudo.
    expect(findInvocations(`sudo /opt/a=b gh pr list`, ["gh"])).toEqual([]);
  });
});

describe("what stays as it was", () => {
  it.each([
    `env 'ZZC^=1' ls`,
    `env 'ZZC^=1'`,
    `env 'ZZC^=1' gh --version`,
  ])("%j passes and starts nothing", async (line) => {
    expect((await hook(line)).decision).toBe("allow");
    expect(calls).toEqual([]);
  });

  it("outside env such a word is a command, not a variable: nothing is followed", async () => {
    expect(findInvocations(`'ZZC^=1' gh pr list`, ["gh"])).toEqual([]);
    expect(findInvocations(`nice 'ZZC^=1' gh pr list`, ["gh"])).toEqual([]);
  });

  it("an identifier after env, as before", async () => {
    expect((await hook(`env ZZC=1 az group list --subscription other`)).decision).toBe("deny");
    expect(calls).toHaveLength(1);
  });
});
