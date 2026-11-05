import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultFindConfig, type GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { github } from "../src/providers/github.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #163, the environment family, through the real hook with a real pin file and a fake Exec. GH_TOKEN picks the
// account: the pin is PIN_USER, and the fake answers with another login only for WRONG. FOO picks nothing. So each
// spelling has a control both ways: VALUE=WRONG must deny, VALUE=RIGHT must pass. Every spelling was checked against
// real Git Bash and Windows PowerShell 5.1 with a printer named like the CLI.

export const PIN_USER = "pinned-user";
export const WRONG = "fake-wrong-account-value";
export const RIGHT = "fake-right-account-value";
export const CALL = "gh pr list";
/** Words of the "can't tell" answers: a line that may set anything, and a named variable. */
export const ANYTHING = "can set environment variables cloudpin can't read";
export const NAMED = "GH_TOKEN is set by the command line";

/** What the fake CLI was asked, with the variables it was given. */
export const asked: { args: string[]; token: string | undefined }[] = [];
const exec: Exec = async (bin, args, env) => {
  asked.push({ args: [bin, ...args], token: env.GH_TOKEN });
  return { code: 0, stdout: env.GH_TOKEN?.includes(WRONG) ? "someone-else\n" : `${PIN_USER}\n`, stderr: "" };
};
export const deps: GuardDeps = { providers: [github], exec, findConfig: defaultFindConfig };

export const pinned = realpathSync(tempDir("cloudpin-163-env-"));
writeFileSync(join(pinned, ".cloudpin.yml"), `github:\n  user: ${PIN_USER}\n`);
/** No pin file at or above it. */
export const bare = realpathSync(tempDir("cloudpin-163-env-bare-"));
/** A pin file for another provider. */
export const otherPin = realpathSync(tempDir("cloudpin-163-env-az-"));
writeFileSync(join(otherPin, ".cloudpin.yml"), "azure:\n  subscription: 11111111-0000-0000-0000-000000000001\n");

export type Shell = "Bash" | "PowerShell";
export interface Answer {
  decision: string;
  reason: string;
}

export async function hook(command: string, tool: Shell, env: NodeJS.ProcessEnv = {}, cwd = pinned, platform: NodeJS.Platform = "linux"): Promise<Answer> {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd });
  const out = await runHook(AGENTS.claude, input, { ...deps, platform }, env, undefined, platform);
  if (!out) return { decision: "allow", reason: "" };
  const { permissionDecision, permissionDecisionReason } = JSON.parse(out).hookSpecificOutput;
  return { decision: permissionDecision, reason: permissionDecisionReason };
}

/** Each shape with VALUE, then the call unless it has one: WRONG denies without being printed, RIGHT passes. */
export function followed(tool: Shell, shapes: string[], env: NodeJS.ProcessEnv = {}) {
  it.each(shapes)("follows %j", async (shape) => {
    const fill = (value: string) => {
      const line = shape.split("VALUE").join(value);
      return line.includes(CALL) ? line : `${line}; ${CALL}`;
    };
    const wrong = await hook(fill(WRONG), tool, env);
    expect(wrong.decision).toBe("deny");
    expect(wrong.reason).toContain("someone-else");
    expect(wrong.reason.split(fill(WRONG)).join("")).not.toContain(WRONG);
    expect((await hook(fill(RIGHT), tool, env)).decision).toBe("allow");
  });
}

/** Each line, then the call unless it has one: the shell doesn't give the CLI the variable, so WRONG passes too. */
export function notSet(tool: Shell, lines: string[], env: NodeJS.ProcessEnv = {}) {
  it.each(lines)("does not carry %j", async (shape) => {
    const line = shape.split("VALUE").join(WRONG);
    expect((await hook(line.includes(CALL) ? line : `${line}; ${CALL}`, tool, env)).decision).toBe("allow");
  });
}

/**
 * Each line, then the call: can't tell, for any provider's variable, naming no value. An exempt call and a line with
 * no guarded call pass, and with no pin in play (none in sight, or one that doesn't pin this CLI) nothing stops.
 */
export function refused(tool: Shell, lines: string[], env: NodeJS.ProcessEnv = {}) {
  it.each(lines)("refuses %j", async (line) => {
    const stopped = await hook(`${line}; ${CALL}`, tool, env);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(ANYTHING);
    expect((await hook(`${line}; gh --version`, tool, env)).decision).toBe("allow");
    expect((await hook(`${line}; gh auth status`, tool, env)).decision).toBe("allow");
    expect((await hook(`${line}; ls`, tool, env)).decision).toBe("allow");
    // Line order: a call before it isn't affected.
    expect((await hook(`${CALL}; ${line}`, tool, env)).decision).toBe("allow");
    asked.length = 0;
    expect((await hook(`${line}; ${CALL}`, tool, env, bare)).decision).toBe("allow");
    expect((await hook(`${line}; ${CALL}`, tool, env, otherPin)).decision).toBe("allow");
    expect(asked).toEqual([]);
  });
}

/** Each line, then the call: can't tell only for a variable that picks this CLI's account. */
export function refusedByName(tool: Shell, lines: string[], env: NodeJS.ProcessEnv = {}) {
  it.each(lines)("refuses GH_TOKEN in %j, and only that", async (shape) => {
    const fill = (name: string) => {
      const line = shape.split("NAME").join(name);
      return line.includes(CALL) ? line : `${line}; ${CALL}`;
    };
    const stopped = await hook(fill("GH_TOKEN"), tool, env);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(NAMED);
    expect((await hook(fill("FOO"), tool, env)).decision).toBe("allow");
    asked.length = 0;
    expect((await hook(fill("GH_TOKEN"), tool, env, bare)).decision).toBe("allow");
    expect(asked).toEqual([]);
  });
}
