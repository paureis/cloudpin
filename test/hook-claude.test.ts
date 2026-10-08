import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { claudeHook } from "../src/hooks/claude.js";
import type { ProviderDef } from "../src/types.js";

// A fake gh whose active user comes from the env, so tests can vary it per call.
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
  findConfig: () => config,
};

const input = (command: string, tool = "Bash") =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd: "/repo" });

describe("claudeHook", () => {
  it("prints nothing when every call matches, leaving normal permissions in charge", async () => {
    expect(await claudeHook(input("gh pr list && git push"), deps, {})).toBe("");
  });

  it("prints nothing for commands without guarded CLIs", async () => {
    expect(await claudeHook(input("npm test"), deps, {})).toBe("");
  });

  it("ignores tools other than Bash and PowerShell", async () => {
    expect(await claudeHook(input("gh pr list", "Edit"), deps, { FAKE_GH_USER: "x" })).toBe("");
  });

  it("denies a call on the wrong account, explaining it to the agent", async () => {
    const out = JSON.parse(await claudeHook(input("cd app && gh pr list"), deps, { FAKE_GH_USER: "someone" }));
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason: string = out.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("blocked `gh pr list`");
    expect(reason).toContain("ask the user");
    expect(reason).not.toContain("CLOUDPIN_SKIP=1 gh");
  });

  it("applies VAR=value prefixes from the command line", async () => {
    const out = await claudeHook(input("FAKE_GH_USER=someone gh pr list"), deps, {});
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("does not let the agent opt out with CLOUDPIN_SKIP", async () => {
    const out = await claudeHook(input("CLOUDPIN_SKIP=1 gh pr list"), deps, { FAKE_GH_USER: "someone" });
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("covers the PowerShell tool too", async () => {
    const out = await claudeHook(input("gh pr list", "PowerShell"), deps, { FAKE_GH_USER: "someone" });
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("allows exempt commands such as switching accounts", async () => {
    expect(await claudeHook(input("gh auth switch --user paureis"), deps, { FAKE_GH_USER: "someone" })).toBe("");
  });

  it("checks a call after cd against the pins of the folder it moved to", async () => {
    const perFolder: GuardDeps = {
      ...deps,
      findConfig: (cwd) =>
        cwd.endsWith("other")
          ? { path: `${cwd}/.cloudpin.yml`, pins: { github: { user: "someone-else" } } }
          : config,
    };
    const out = await claudeHook(input("cd ../other && gh pr list"), perFolder, {});
    expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toContain('expected "someone-else"');
  });

  it("stays out of the way when the input is not valid hook JSON", async () => {
    expect(await claudeHook("not json", deps, {})).toBe("");
  });
});
