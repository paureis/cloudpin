import { formatBlock } from "../format.js";
import { guard, type GuardDeps } from "../guard.js";
import { findInvocations } from "../shellwords.js";

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

interface HookInput {
  tool_name?: string;
  tool_input?: { command?: unknown };
  cwd?: string;
}

/**
 * Claude Code PreToolUse hook (code.claude.com/docs/en/hooks). Returns the
 * text to print on stdout: a "deny" decision when any cloud CLI call in the
 * command would act on the wrong account, otherwise "" so Claude Code's own
 * permission rules decide. It never returns "allow", which would bypass them.
 */
export async function claudeHook(stdin: string, deps: GuardDeps, env: NodeJS.ProcessEnv): Promise<string> {
  let input: HookInput;
  try {
    input = JSON.parse(stdin) as HookInput;
  } catch {
    return "";
  }
  const command = input.tool_input?.command;
  if (!SHELL_TOOLS.has(input.tool_name ?? "") || typeof command !== "string") return "";

  const bins = deps.providers.flatMap((p) => p.bins);
  const cwd = input.cwd ?? process.cwd();
  const reasons: string[] = [];
  for (const call of findInvocations(command, bins)) {
    const verdict = await guard(
      { bin: call.bin, args: call.args, env: { ...env, ...call.env }, cwd, mode: "agent" },
      deps,
    );
    if (verdict.action === "block") {
      reasons.push(formatBlock(verdict, [call.bin, ...call.args], "agent"));
    }
  }
  if (reasons.length === 0) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reasons.join("\n\n"),
    },
  });
}
