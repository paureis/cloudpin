import { describe, expect, it } from "vitest";
import { explain } from "../src/explain.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { calls, deps, hook, pinned, SECRET, type Shell } from "./hook-line-env-fixture.js";

// `cloudpin switch` starts the CLIs in its own process with its own environment, which the line chose, so the rule for
// the lookup (the hook's PATH) can't apply. The hook asks the person, and showed only cloudpin's own variables.
const env = { PATH: "/hook/bin" };

describe("an agent's cloudpin switch with a variable that can run code on its line is refused", () => {
  it.each<[Shell, string, string]>([
    ["Bash", `PATH=${SECRET} cloudpin switch`, "PATH"],
    ["Bash", `PATH=${SECRET} cloudpin switch --yes`, "PATH"],
    ["Bash", `export PATH=/x:$PATH; cloudpin switch`, "PATH"],
    ["Bash", `NODE_OPTIONS=${SECRET} cloudpin switch`, "NODE_OPTIONS"],
    ["Bash", `PYTHONPATH=${SECRET} cloudpin switch --only azure`, "PYTHONPATH"],
    ["Bash", `PATH=${SECRET} cloudpin "$x"`, "PATH"],
    ["Bash", `PATH=${SECRET} npx cloudpin switch`, "PATH"],
    ["PowerShell", `$env:PATH='${SECRET}'; cloudpin switch`, "PATH"],
    ["PowerShell", `$env:NODE_OPTIONS='${SECRET}'; cloudpin switch`, "NODE_OPTIONS"],
  ])("%s: %s", async (tool, line, name) => {
    const answer = await hook(line, { tool, env });
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain(name);
    expect(answer.reason).not.toContain(SECRET);
    expect(calls).toEqual([]);
  });

  it("an agent whose hook can't ask gets the same answer", async () => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `PATH=${SECRET} cloudpin switch` }, cwd: pinned });
    const out = JSON.parse(await runHook(AGENTS.codex, input, { ...deps, platform: "linux" }, env, undefined, "linux"));
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("PATH");
  });

  it("explain says so, and starts nothing", async () => {
    calls.length = 0;
    const [call] = await explain(`NODE_OPTIONS=${SECRET} cloudpin switch`, { mode: "agent", cwd: pinned, env }, { ...deps, platform: "linux" });
    expect(call!.verdict).toBe("block");
    expect(call!.reason).toContain("NODE_OPTIONS");
    expect(JSON.stringify(call)).not.toContain(SECRET);
    expect(calls).toEqual([]);
  });

  it("with the name in any case on Windows", async () => {
    expect((await hook(`$env:node_options='${SECRET}'; cloudpin switch`, { tool: "PowerShell", env: { Path: "C:\\hook" }, platform: "win32" })).decision).toBe("deny");
    expect((await hook(`$env:path='${SECRET}'; cloudpin switch`, { tool: "PowerShell", env: { Path: "C:\\hook" }, platform: "win32" })).decision).toBe("deny");
  });
});

describe("what stays as it was", () => {
  it.each(["cloudpin switch", "cloudpin switch --yes", "FOO=bar cloudpin switch", "GH_TOKEN=x cloudpin switch", "CLOUDPIN_ENV=prod cloudpin switch", "PATH=/hook/bin cloudpin switch"])("%s asks", async (line) => {
    expect((await hook(line, { env })).decision).toBe("ask");
  });

  it("a variable set before the agent started is the user's: the switch asks", async () => {
    expect((await hook("cloudpin switch", { env: { ...env, NODE_OPTIONS: "--no-warnings" } })).decision).toBe("ask");
  });

  it.each(["PATH=/x cloudpin switch --help", "PATH=/x cloudpin status", "PATH=/x cloudpin doctor", "NODE_OPTIONS=x cloudpin --version"])("%s is the agent's own command, and starts nothing during the check", async (line) => {
    expect((await hook(line, { env })).decision).toBe("allow");
    expect(calls).toEqual([]);
  });
});
