import type { Verdict } from "./guard.js";

type Block = Extract<Verdict, { action: "block" }>;

function displayCommand(argv: string[]): string {
  return argv.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

/** The message shown when a command is blocked, for a human or an agent. */
export function formatBlock(verdict: Block, argv: string[], mode: "shell" | "agent"): string {
  const command = displayCommand(argv);
  const lines = verdict.uncertain
    ? [
        `cloudpin: stopped \`${command}\` because it could not tell which ${verdict.provider ?? "cloud"} account it would use`,
      ]
    : [`cloudpin: blocked \`${command}\``];
  if (verdict.provider && verdict.configPath) {
    lines.push(`  ${verdict.provider} is pinned in ${verdict.configPath}`);
  }
  for (const problem of verdict.problems) {
    lines.push(verdict.uncertain ? `  - reason: ${problem}` : `  - ${problem}`);
  }
  if (verdict.uncertain) {
    lines.push("  This is a safety stop: cloudpin blocks whenever it cannot confirm the account.");
    if (verdict.fix) lines.push(`  to see what is wrong: ${verdict.fix}`);
  } else if (verdict.fix) {
    lines.push(`  fix: ${verdict.fix}`);
  }
  lines.push(
    mode === "agent"
      ? "  Do not work around this; ask the user to switch accounts or confirm."
      : `  (to run it anyway, once: CLOUDPIN_SKIP=1 ${command})`,
  );
  return lines.join("\n");
}
