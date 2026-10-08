import { formatConfirm } from "./format.js";
import type { Verdict } from "./guard.js";

export interface ConfirmIO {
  /** Whether a person can answer (stdin and stderr are terminals). */
  isTTY: boolean;
  ask(question: string): Promise<string>;
  print(line: string): void;
}

/**
 * Asks a human at the terminal before a command on a protected environment.
 * Without a terminal it stops and names CLOUDPIN_CONFIRM, so scripts and CI
 * must opt in explicitly. Anything but "y" or "yes" means no.
 */
export async function confirmProtected(
  verdict: Extract<Verdict, { action: "confirm" }>,
  argv: string[],
  io: ConfirmIO,
): Promise<boolean> {
  if (!io.isTTY) {
    io.print(formatConfirm(verdict, argv, "no-terminal"));
    return false;
  }
  const answer = await io.ask(formatConfirm(verdict, argv, "prompt"));
  if (/^y(es)?$/i.test(answer.trim())) return true;
  io.print("cloudpin: not run.");
  return false;
}
