import { resolve } from "node:path";
import { formatBlock } from "../format.js";
import { guard, type GuardDeps } from "../guard.js";
import { findInvocations } from "../shellwords.js";

/** How one agent hands a shell command to its hook and reads the answer. */
export interface AgentHook {
  /** Extracts the shell command and its folder, or null if the call is not a shell command. */
  parse(input: unknown): { command: string; cwd: string } | null;
  /** Output that blocks the command with `reason`. */
  deny(reason: string): string;
  /** Output when cloudpin has no objection; must not weaken the agent's own approvals. */
  noObjection: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// Claude Code (code.claude.com/docs/en/hooks) and Codex (learn.chatgpt.com/docs/hooks)
// share the PreToolUse protocol: tool_input.command in, hookSpecificOutput out.
function preToolUse(tools: string[]): AgentHook {
  return {
    parse(input) {
      const i = obj(input);
      const command = str(obj(i.tool_input).command);
      if (!tools.includes(str(i.tool_name) ?? "") || command === undefined) return null;
      return { command, cwd: str(i.cwd) ?? process.cwd() };
    },
    deny: (reason) =>
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    // Printing nothing leaves the agent's own permission rules in charge;
    // answering "allow" would bypass them.
    noObjection: "",
  };
}

export const AGENTS = {
  claude: preToolUse(["Bash", "PowerShell"]),
  codex: preToolUse(["Bash", "PowerShell"]),

  // GitHub Copilot CLI (docs.github.com, hooks configuration): toolArgs is a
  // JSON-encoded string in the documented example; empty output = default.
  copilot: {
    parse(input) {
      const i = obj(input);
      if (!["bash", "powershell"].includes(str(i.toolName) ?? "")) return null;
      let args: unknown = i.toolArgs;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          return null;
        }
      }
      const command = str(obj(args).command);
      return command === undefined ? null : { command, cwd: str(i.cwd) ?? process.cwd() };
    },
    deny: (reason) => JSON.stringify({ permissionDecision: "deny", permissionDecisionReason: reason }),
    noObjection: "",
  },

  // Gemini CLI (geminicli.com/docs/hooks/reference): BeforeTool, tool
  // run_shell_command with command and optional dir_path; deny = decision + reason.
  gemini: {
    parse(input) {
      const i = obj(input);
      const toolInput = obj(i.tool_input);
      const command = str(toolInput.command);
      if (str(i.tool_name) !== "run_shell_command" || command === undefined) return null;
      const base = str(i.cwd) ?? process.cwd();
      const dir = str(toolInput.dir_path);
      return { command, cwd: dir ? resolve(base, dir) : base };
    },
    deny: (reason) => JSON.stringify({ decision: "deny", reason }),
    noObjection: "",
  },

  // Cursor (cursor.com/docs/agent/hooks): beforeShellExecution gets
  // { command, cwd }. Output must be valid JSON with a permission, and the
  // docs do not say whether "allow" skips Cursor's own approval, so
  // "no objection" is "ask": Cursor's normal approval applies.
  cursor: {
    parse(input) {
      const i = obj(input);
      const command = str(i.command);
      return command === undefined ? null : { command, cwd: str(i.cwd) ?? process.cwd() };
    },
    deny: (reason) =>
      JSON.stringify({
        permission: "deny",
        user_message: reason,
        agent_message: reason,
      }),
    noObjection: JSON.stringify({ permission: "ask" }),
  },
} satisfies Record<string, AgentHook>;

export type AgentName = keyof typeof AGENTS;

/**
 * Runs cloudpin as an agent hook: finds every cloud CLI call in the command
 * and returns the agent's deny output if any would act on the wrong account.
 */
export async function runHook(
  agent: AgentHook,
  stdin: string,
  deps: GuardDeps,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  let call: { command: string; cwd: string } | null;
  try {
    call = agent.parse(JSON.parse(stdin));
  } catch {
    return agent.noObjection;
  }
  if (!call) return agent.noObjection;

  const bins = deps.providers.flatMap((p) => p.bins);
  const reasons: string[] = [];
  for (const inv of findInvocations(call.command, bins, call.cwd)) {
    const verdict = await guard(
      { bin: inv.bin, args: inv.args, env: { ...env, ...inv.env }, cwd: inv.cwd ?? call.cwd, mode: "agent" },
      deps,
    );
    if (verdict.action === "block") reasons.push(formatBlock(verdict, [inv.bin, ...inv.args], "agent"));
  }
  return reasons.length === 0 ? agent.noObjection : agent.deny(reasons.join("\n\n"));
}
