import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultFindConfig, type GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { azure } from "../src/providers/azure.js";
import { github } from "../src/providers/github.js";
import { kubernetes } from "../src/providers/kubernetes.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// Variables a line sets that make a program run code: through the real hook with a real pin file and a fake Exec,
// which records every process cloudpin would have started. "Nothing ran" is `calls` staying empty.

export const PIN_USER = "pinned-user";
export const PIN_SUB = "11111111-0000-0000-0000-000000000001";
export const WRONG_TOKEN = "fake-wrong-account-value";
/** Never appears in an answer: the value of a variable set on the line. */
export const SECRET = "fake-value-that-must-not-be-printed";

export const calls: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
export const state = { missing: false };

const exec: Exec = async (bin, args, env) => {
  calls.push({ bin, args, env });
  if (state.missing) return { code: 127, stdout: "", stderr: `${bin}: not found on PATH`, notFound: true };
  if (bin === "az") {
    const other = args.includes("--subscription") && !args.includes(PIN_SUB);
    return { code: 0, stdout: JSON.stringify({ id: other ? "22222222-0000-0000-0000-000000000002" : PIN_SUB, tenantId: "t" }), stderr: "" };
  }
  return { code: 0, stdout: env.GH_TOKEN?.includes(WRONG_TOKEN) ? "someone-else\n" : `${PIN_USER}\n`, stderr: "" };
};
export const deps: GuardDeps = { providers: [github, azure, kubernetes], exec, findConfig: defaultFindConfig };

export const pinned = realpathSync(tempDir("cloudpin-line-env-"));
writeFileSync(join(pinned, ".cloudpin.yml"), `github:\n  user: ${PIN_USER}\nazure:\n  subscription: ${PIN_SUB}\n`);
/** No pin file at or above it. */
export const bare = realpathSync(tempDir("cloudpin-line-env-bare-"));
/** A pin file for another provider only. */
export const otherPin = realpathSync(tempDir("cloudpin-line-env-other-"));
writeFileSync(join(otherPin, ".cloudpin.yml"), `azure:\n  subscription: ${PIN_SUB}\n`);

export type Shell = "Bash" | "PowerShell";
export interface Answer {
  decision: string;
  reason: string;
}

/** Runs the hook on a clean record of calls. */
export async function hook(
  command: string,
  { tool = "Bash", env = {}, cwd = pinned, platform = "linux" }: { tool?: Shell; env?: NodeJS.ProcessEnv; cwd?: string; platform?: NodeJS.Platform } = {},
): Promise<Answer> {
  calls.length = 0;
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd });
  const out = await runHook(AGENTS.claude, input, { ...deps, platform }, env);
  if (!out) return { decision: "allow", reason: "" };
  const { permissionDecision, permissionDecisionReason } = JSON.parse(out).hookSpecificOutput;
  return { decision: permissionDecision, reason: permissionDecisionReason };
}
