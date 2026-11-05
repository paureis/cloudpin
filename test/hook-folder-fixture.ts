import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultFindConfig, type GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { azure } from "../src/providers/azure.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #163, the folder family, through the real hook with real nested pin files and a fake Exec. The active
// subscription is the one the top pin file pins. `sub` has its own pin file with another subscription, so a call
// read as running in `sub` is denied; `other` has none, so a call read as running there passes. So each spelling
// has a control both ways: DIR=sub must deny, DIR=other must pass. Every spelling was checked against real Git
// Bash and Windows PowerShell 5.1 with a printer.

export const PINNED = "11111111-0000-0000-0000-000000000001";
const OTHER = "22222222-0000-0000-0000-000000000002";
export const sent: string[][] = [];
const exec: Exec = async (bin, args) => {
  sent.push([bin, ...args]);
  return { code: 0, stdout: JSON.stringify({ id: PINNED, tenantId: PINNED, name: "x" }), stderr: "" };
};
export const deps: GuardDeps = { providers: [azure], exec, findConfig: defaultFindConfig };

const pin = (dir: string, subscription: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".cloudpin.yml"), `azure:\n  subscription: ${subscription}\n`);
};
export const root = realpathSync(tempDir("cloudpin-163-folder-"));
pin(root, PINNED);
pin(join(root, "sub"), OTHER);
mkdirSync(join(root, "other"));
export const SUB_PIN = join(root, "sub", ".cloudpin.yml");

export type Shell = "Bash" | "PowerShell";
export const CALL = "az group list";
export const CANT_TELL = "the folder this command runs in is only known when the command runs";

export async function hook(command: string, tool: Shell = "Bash", env: NodeJS.ProcessEnv = {}, cwd = root): Promise<{ decision: string; reason: string }> {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd });
  const out = await runHook(AGENTS.claude, input, deps, env, undefined, "linux");
  if (!out) return { decision: "allow", reason: "" };
  const { permissionDecision, permissionDecisionReason } = JSON.parse(out).hookSpecificOutput;
  return { decision: permissionDecision, reason: permissionDecisionReason };
}

/** Each shape with DIR where the folder goes, then the call: the wrong pin denies, and no nested pin passes. */
export function followed(tool: Shell, shapes: string[], env: NodeJS.ProcessEnv = {}) {
  it.each(shapes)("follows %j", async (shape) => {
    const fill = (dir: string) => `${shape.split("DIR").join(dir)}; ${CALL}`;
    const wrong = await hook(fill("sub"), tool, env);
    expect(wrong.decision).toBe("deny");
    expect(wrong.reason).toContain(SUB_PIN);
    expect((await hook(fill("other"), tool, env)).decision).toBe("allow");
  });
}

/** Each line, then the call: can't tell, naming no folder; an exempt call and a line with no guarded call pass. */
export function refused(tool: Shell, lines: string[], env: NodeJS.ProcessEnv = {}) {
  it.each(lines)("refuses %j", async (line) => {
    const stopped = await hook(`${line}; ${CALL}`, tool, env);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(CANT_TELL);
    expect((await hook(`${line}; az version`, tool, env)).decision).toBe("allow");
    expect((await hook(`${line}; az login`, tool, env)).decision).toBe("allow");
    expect((await hook(`${line}; ls`, tool, env)).decision).toBe("allow");
  });
}
