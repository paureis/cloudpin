import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import type { ProviderDef } from "../src/types.js";

// Fake gh whose active user comes from FAKE_GH_USER, defaulting to the pinned one.
const gh: ProviderDef<"github"> = {
  name: "github",
  bins: ["gh"],
  isExempt: (args) => args[0] === "auth",
  resolve: async ({ env }) => ({ kind: "identity", identity: { user: env.FAKE_GH_USER ?? "paureis" }, source: "t" }),
  compare: (pin, id) => (pin.user === id.user ? [] : [`user: expected "${pin.user}", active is "${id.user}"`]),
  switchHint: (pin) => `gh auth switch --user ${pin.user}`,
  statusCommand: "gh auth status",
  cacheInputs: () => ({ env: [], files: [], dirs: [] }),
};
const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { github: { user: "paureis" } } };
const deps: GuardDeps = {
  providers: [gh as ProviderDef],
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  findConfig: (cwd) => (cwd.replace(/\\/g, "/").includes("/elsewhere") ? null : config),
};
const wrong = { FAKE_GH_USER: "someone" };

// Inputs shaped as each agent's documentation describes them.
const inputs = {
  codex: (command: string) =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/repo" }),
  copilot: (command: string) =>
    JSON.stringify({ timestamp: 1, cwd: "/repo", toolName: "bash", toolArgs: JSON.stringify({ command }) }),
  gemini: (command: string, dir?: string) =>
    JSON.stringify({
      hook_event_name: "BeforeTool",
      cwd: "/repo",
      tool_name: "run_shell_command",
      tool_input: { command, ...(dir ? { dir_path: dir } : {}) },
    }),
  cursor: (command: string) => JSON.stringify({ command, cwd: "/repo", sandbox: false }),
};

describe("runHook: codex (same protocol as Claude Code)", () => {
  it("denies through hookSpecificOutput", async () => {
    const out = JSON.parse(await runHook(AGENTS.codex, inputs.codex("gh pr list"), deps, wrong));
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
  });
  it("prints nothing when there is no problem", async () => {
    expect(await runHook(AGENTS.codex, inputs.codex("gh pr list"), deps, {})).toBe("");
  });
});

describe("runHook: copilot", () => {
  it("parses the JSON-encoded toolArgs and denies with permissionDecision", async () => {
    const out = JSON.parse(await runHook(AGENTS.copilot, inputs.copilot("gh pr list"), deps, wrong));
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain("blocked `gh pr list`");
  });
  it("also accepts toolArgs as an object, and the powershell tool", async () => {
    const input = JSON.stringify({ cwd: "/repo", toolName: "powershell", toolArgs: { command: "gh pr list" } });
    expect(JSON.parse(await runHook(AGENTS.copilot, input, deps, wrong)).permissionDecision).toBe("deny");
  });
  it("prints nothing when there is no problem (default behaviour)", async () => {
    expect(await runHook(AGENTS.copilot, inputs.copilot("gh pr list"), deps, {})).toBe("");
  });
});

describe("runHook: gemini", () => {
  it("denies with decision and reason", async () => {
    const out = JSON.parse(await runHook(AGENTS.gemini, inputs.gemini("gh pr list"), deps, wrong));
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("blocked `gh pr list`");
  });
  it("checks against dir_path when the command runs elsewhere", async () => {
    // /elsewhere has no pin file, so nothing is blocked there.
    expect(await runHook(AGENTS.gemini, inputs.gemini("gh pr list", "/elsewhere"), deps, wrong)).toBe("");
  });
  it("ignores other tools", async () => {
    const input = JSON.stringify({ cwd: "/repo", tool_name: "write_file", tool_input: { content: "gh" } });
    expect(await runHook(AGENTS.gemini, input, deps, wrong)).toBe("");
  });
});

describe("runHook: cursor", () => {
  it("denies with messages for the user and the agent", async () => {
    const out = JSON.parse(await runHook(AGENTS.cursor, inputs.cursor("gh pr list"), deps, wrong));
    expect(out.permission).toBe("deny");
    expect(out.user_message).toContain("blocked `gh pr list`");
    expect(out.agent_message).toContain("ask the user");
  });
  it("answers ask (Cursor's own approval) rather than allow when there is no problem", async () => {
    expect(JSON.parse(await runHook(AGENTS.cursor, inputs.cursor("gh pr list"), deps, {}))).toEqual({
      permission: "ask",
    });
  });
});

describe("runHook: input that is not for us", () => {
  it.each(Object.keys(AGENTS))("%s stays out of the way on invalid JSON", async (name) => {
    const agent = AGENTS[name as keyof typeof AGENTS];
    expect(await runHook(agent, "not json", deps, wrong)).toBe(agent.noObjection);
  });
});
