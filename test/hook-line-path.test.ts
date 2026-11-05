import { beforeEach, describe, expect, it } from "vitest";
import { explain } from "../src/explain.js";
import { calls, deps, hook, pinned, PIN_USER, type Shell, state, WRONG_TOKEN } from "./hook-line-env-fixture.js";

beforeEach(() => {
  state.missing = false;
});

const HOOK_PATH = "/hook/bin:/usr/bin";
const CALL = "gh pr list";
const env = { PATH: HOOK_PATH };

// Agents write PATH=/some/bin:$PATH for honest reasons (15 of 23,342 shell lines naming a CLI, none of them a stop on a
// pin), so a line's PATH doesn't stop a call. It never reaches the lookup: the CLI, and what a shim starts by bare
// name (npm's cmd-shim runs `node` from PATH), come from the hook's own PATH.
describe("the lookup finds the CLI on the hook's PATH, not the line's", () => {
  it.each<[Shell, string]>([
    ["Bash", `PATH=/planted ${CALL}`],
    ["Bash", `PATH=/planted:$PATH ${CALL}`],
    ["Bash", `export PATH=/planted; ${CALL}`],
    ["Bash", `export PATH=/planted:$PATH; ${CALL}`],
    ["Bash", `export PATH="/planted:$PATH"; ${CALL}`],
    ["Bash", `set -a; PATH=/planted; ${CALL}`],
    ["Bash", `PATH=/planted; ${CALL}`],
    ["Bash", `PATH=$(cat f) ${CALL}`],
    ["Bash", `env PATH=/planted ${CALL}`],
    ["Bash", `unset PATH; ${CALL}`],
    ["PowerShell", `$env:PATH='/planted'; ${CALL}`],
    ["PowerShell", `$env:PATH = '/planted;' + $env:PATH; ${CALL}`],
    ["PowerShell", `Set-Item env:PATH '/planted'; ${CALL}`],
    ["PowerShell", `[Environment]::SetEnvironmentVariable('PATH','/planted'); ${CALL}`],
  ])("%s: %s", async (tool, line) => {
    const answer = await hook(line, { tool, env });
    expect(answer.decision).toBe("allow");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.PATH).toBe(HOOK_PATH);
  });

  it("with the name in any case on Windows, whichever spelling the environment has", async () => {
    for (const line of [`$env:path='C:\\planted'; ${CALL}`, `$env:Path='C:\\planted'; ${CALL}`, `$env:PATH='C:\\planted'; ${CALL}`]) {
      for (const base of [{ Path: "C:\\hook" }, { PATH: "C:\\hook" }, { path: "C:\\hook" }]) {
        expect((await hook(line, { tool: "PowerShell", env: base, platform: "win32" })).decision).toBe("allow");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.env.PATH).toBe("C:\\hook");
        expect(Object.values(calls[0]!.env)).not.toContain("C:\\planted");
      }
    }
  });

  it("PATHEXT, which picks the file on Windows, comes from the hook as well", async () => {
    const base = { Path: "C:\\hook", PATHEXT: ".EXE;.CMD" };
    expect((await hook(`$env:PATHEXT='.PLANTED'; ${CALL}`, { tool: "PowerShell", env: base, platform: "win32" })).decision).toBe("allow");
    expect(calls[0]!.env.PATHEXT).toBe(".EXE;.CMD");
    expect((await hook(`$env:pathext='.PLANTED'; ${CALL}`, { tool: "PowerShell", env: base, platform: "win32" })).decision).toBe("allow");
    expect(calls[0]!.env.PATHEXT).toBe(".EXE;.CMD");
  });

  it("a hook with no PATHEXT leaves the lookup none", async () => {
    await hook(`PATHEXT=.PLANTED ${CALL}`, { env });
    expect(calls[0]!.env.PATHEXT).toBeUndefined();
  });

  it("the rest of the line's variables still reach the lookup, and pick the account", async () => {
    const answer = await hook(`export PATH=/x:$PATH; GH_TOKEN=${WRONG_TOKEN} ${CALL}`, { env });
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain("someone-else");
    expect(calls[0]!.env.PATH).toBe(HOOK_PATH);
  });

  it("a wrong account denies through a line's PATH, which used to read as a CLI not installed", async () => {
    expect((await hook(`PATH=/x:$PATH az group list --subscription other`, { env })).decision).toBe("deny");
    expect(calls).toHaveLength(1);
    expect((await hook(`export PATH=/x:$PATH; az group list --subscription other`, { env })).decision).toBe("deny");
    expect(calls).toHaveLength(1);
  });

  it("a line that doesn't touch PATH: the same PATH, as a control", async () => {
    expect((await hook(CALL, { env })).decision).toBe("allow");
    expect(calls[0]!.env.PATH).toBe(HOOK_PATH);
  });
});

describe("a CLI the hook's PATH doesn't have", () => {
  it("can't tell when the line changed PATH: it may be on the line's", async () => {
    state.missing = true;
    for (const line of [`PATH=/only/here ${CALL}`, `export PATH=/only/here:$PATH; ${CALL}`, `unset PATH; ${CALL}`]) {
      const answer = await hook(line, { env });
      expect(answer.decision).toBe("deny");
      expect(answer.reason).toContain("PATH");
      expect(answer.reason).toContain("can't tell");
      expect(answer.reason).not.toContain("/only/here");
    }
  });

  it("with PATHEXT changed too", async () => {
    state.missing = true;
    expect((await hook(`$env:PATHEXT='.X'; ${CALL}`, { tool: "PowerShell", env: { Path: "C:\\hook", PATHEXT: ".EXE" }, platform: "win32" })).decision).toBe("deny");
  });

  it("with PATH in another spelling on Windows, which guard's folding would lose", async () => {
    state.missing = true;
    expect((await hook(`$env:path='C:\\there'; ${CALL}`, { tool: "PowerShell", env: { Path: "C:\\hook" }, platform: "win32" })).decision).toBe("deny");
    expect((await hook(`Remove-Item env:PATH; ${CALL}`, { tool: "PowerShell", env: { Path: "C:\\hook" }, platform: "win32" })).decision).toBe("deny");
  });

  it("not installed when the line left PATH alone: the command would fail on its own", async () => {
    state.missing = true;
    expect((await hook(CALL, { env })).decision).toBe("allow");
    expect((await hook(`FOO=bar ${CALL}`, { env })).decision).toBe("allow");
    // The same value is no change.
    expect((await hook(`PATH=${HOOK_PATH} ${CALL}`, { env })).decision).toBe("allow");
  });
});

describe("explain agrees", () => {
  it("looks up on the hook's PATH", async () => {
    calls.length = 0;
    const [call] = await explain(`PATH=/planted ${CALL}`, { mode: "agent", cwd: pinned, env }, { ...deps, platform: "linux" });
    expect(call!.verdict).toBe("allow");
    expect(call!.identity?.user).toBe(PIN_USER);
    expect(calls[0]!.env.PATH).toBe(HOOK_PATH);
  });
});
