import type { GuardDeps } from "../guard.js";
import { AGENTS, runHook } from "./agents.js";

/**
 * Claude Code PreToolUse hook (code.claude.com/docs/en/hooks). Returns a
 * "deny" decision when any cloud CLI call in a Bash or PowerShell command
 * would act on the wrong account, otherwise "" so Claude Code's own
 * permission rules decide. It never returns "allow", which would bypass them.
 */
export function claudeHook(stdin: string, deps: GuardDeps, env: NodeJS.ProcessEnv): Promise<string> {
  return runHook(AGENTS.claude, stdin, deps, env);
}
