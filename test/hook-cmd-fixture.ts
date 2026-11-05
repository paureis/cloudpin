import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach } from "vitest";
import { defaultFindConfig, type GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { azure } from "../src/providers/azure.js";
import { github } from "../src/providers/github.js";
import { kubernetes } from "../src/providers/kubernetes.js";
import { vercel } from "../src/providers/vercel.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #168: cmd.exe re-reads the arguments of a .cmd or .bat CLI. Through the real hook with a real pin file, a fake Exec and
// fake PATH lookups; no test spawns a CLI. Every form was run first in real Windows PowerShell 5.1 and Git Bash with
// printers shaped like the real az.cmd (with its IF ( ) block) and npm's vercel.cmd.

export const PINNED = "11111111-0000-0000-0000-000000000001";
export const sent: string[][] = [];
const exec: Exec = async (bin, args) => {
  sent.push([bin, ...args]);
  if (bin === "gh") return { code: 0, stdout: "octocat\n", stderr: "" };
  return { code: 0, stdout: JSON.stringify({ id: PINNED, tenantId: PINNED, name: "x" }), stderr: "" };
};

const root = realpathSync(tempDir("cloudpin-168-"));
const write = (dir: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".cloudpin.yml"), text);
};
export const pinned = join(root, "pinned");
write(pinned, `azure:\n  subscription: ${PINNED}\ngithub:\n  user: octocat\n`);
export const withKube = join(root, "kube");
write(withKube, "kubernetes:\n  server: https://other.example.com\n");
export const withVercel = join(root, "vercel");
write(withVercel, "vercel:\n  team: team_x\n");
export const bare = join(root, "bare");
mkdirSync(bare);

/** Where each name resolves, as cloudpin's real lookup answers; `C:\other` is a PATH a line can set. */
export const BIN = "C:\\bin\\";
export const FILES: Record<string, string> = {
  az: `${BIN}az.cmd`,
  "az.cmd": `${BIN}az.cmd`,
  gh: `${BIN}gh.exe`,
  "gh.exe": `${BIN}gh.exe`,
  kubectl: `${BIN}kubectl.exe`,
  vercel: `${BIN}vercel.cmd`,
  npx: `${BIN}npx.cmd`,
  cloudpin: `${BIN}cloudpin.cmd`,
};
let files = FILES;
/** For one test: where names resolve. A name left out isn't on PATH. */
export const resolveTo = (changes: Record<string, string | null>) => {
  files = Object.fromEntries(Object.entries({ ...FILES, ...changes }).filter((e): e is [string, string] => e[1] !== null));
};
beforeEach(() => {
  sent.length = 0;
  files = FILES;
});

export const pathOf = (env: NodeJS.ProcessEnv) => Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1];
const onPath = (bin: string, env: NodeJS.ProcessEnv): string | null => {
  const path = pathOf(env);
  if (path === "C:\\other") return bin === "az" ? "C:\\other\\az.exe" : null;
  return path === "C:\\bin" ? (files[bin] ?? null) : null;
};
export const deps = (platform: NodeJS.Platform = "win32"): GuardDeps => ({ providers: [azure, github, kubernetes, vercel], exec, findConfig: defaultFindConfig, onPath, platform });
export const ENV: NodeJS.ProcessEnv = { PATH: "C:\\bin", ZZP: "--subscription other" };
/** Words of the "can't tell" answer every stop here gives. */
export const RULE = "cmd.exe";

export async function run(agent: keyof typeof AGENTS, input: object, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, withDeps = deps(platform)): Promise<string> {
  return runHook(AGENTS[agent], JSON.stringify(input), withDeps, env, undefined, platform);
}

export type Tool = "PowerShell" | "Bash";
export async function hook(command: string, tool: Tool = "PowerShell", opts: { cwd?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; deps?: GuardDeps } = {}) {
  const platform = opts.platform ?? "win32";
  const input = { hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd: opts.cwd ?? pinned };
  const out = await run("claude", input, opts.env ?? ENV, platform, opts.deps ?? deps(platform));
  if (!out) return { decision: "allow", reason: "" };
  const { permissionDecision, permissionDecisionReason } = JSON.parse(out).hookSpecificOutput;
  return { decision: permissionDecision as string, reason: permissionDecisionReason as string };
}
