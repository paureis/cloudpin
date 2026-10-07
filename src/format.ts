import type { Verdict } from "./guard.js";

type Block = Extract<Verdict, { action: "block" }>;

function displayCommand(argv: string[]): string {
  return argv.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/** The message shown when a command is blocked, for a human or an agent. */
export function formatBlock(verdict: Block, argv: string[], mode: "shell" | "agent"): string {
  const command = displayCommand(argv);
  const lines = [`cloudpin: blocked \`${command}\``];
  if (verdict.provider && verdict.configPath) {
    lines.push(`  ${verdict.provider} is pinned in ${verdict.configPath}`);
  }
  for (const problem of verdict.problems) lines.push(`  - ${problem}`);
  if (verdict.fix) lines.push(`  fix: ${verdict.fix}`);
  lines.push(
    mode === "agent"
      ? "  Do not work around this; ask the user to switch accounts or confirm."
      : `  (to run it anyway, once: CLOUDPIN_SKIP=1 ${command})`,
  );
  return lines.join("\n");
}
