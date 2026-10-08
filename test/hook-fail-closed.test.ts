import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { formatBlock } from "../src/format.js";
import type { GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import type { ProviderDef } from "../src/types.js";

// Safety review before going public (#8): every failure inside the hook must
// block, because agents run the command when a hook errors or times out.
const gh = {
  name: "github",
  bins: ["gh"],
  isExempt: () => false,
  resolve: async () => ({ kind: "identity", identity: { user: "paureis" }, source: "t" }),
  compare: () => [],
  switchHint: () => "",
  statusCommand: "gh auth status",
  cacheInputs: () => ({ env: [], files: [], dirs: [] }),
} as unknown as ProviderDef;
const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { github: { user: "paureis" } } };
const input = (command: string) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd: "/repo" });

describe("runHook fails closed", () => {
  it("denies when something unexpected throws", async () => {
    const deps: GuardDeps = {
      providers: [gh],
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      findConfig: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    };
    const out = JSON.parse(await runHook(AGENTS.claude, input("gh pr list"), deps, {}));
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/cloudpin could not check this command.*EACCES/s);
  });

  it("denies when checking takes longer than the deadline", async () => {
    const slow = { ...gh, resolve: () => new Promise(() => {}) } as unknown as ProviderDef;
    const deps: GuardDeps = { providers: [slow], exec: async () => ({ code: 0, stdout: "", stderr: "" }), findConfig: () => config };
    const out = JSON.parse(await runHook(AGENTS.claude, input("gh pr list"), deps, {}, 50));
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/took longer than/);
  });

  it("still says nothing for commands it has no objection to", async () => {
    const deps: GuardDeps = { providers: [gh], exec: async () => ({ code: 0, stdout: "", stderr: "" }), findConfig: () => config };
    expect(await runHook(AGENTS.claude, input("gh pr list"), deps, {}, 50)).toBe("");
  });
});

describe("block messages hide secret flag values", () => {
  const verdict = { action: "block" as const, problems: ["x"] };
  it.each([
    [["vercel", "deploy", "--token", "abc123secret"]],
    [["vercel", "deploy", "--token=abc123secret"]],
    [["vercel", "deploy", "-t", "abc123secret"]],
    [["kubectl", "get", "pods", "--token", "abc123secret"]],
    [["kubectl", "--password=abc123secret", "get", "pods"]],
    [["helm", "list", "--kube-token", "abc123secret"]],
  ])("masks %j", (argv) => {
    for (const mode of ["shell", "agent"] as const) {
      const text = formatBlock(verdict, argv, mode);
      expect(text).not.toContain("abc123secret");
      expect(text).toContain("***");
    }
  });

  it("leaves other values alone", () => {
    expect(formatBlock(verdict, ["gh", "pr", "view", "-t", "x"], "shell")).toContain("gh pr view -t x");
  });
});
