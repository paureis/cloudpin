import spawn from "cross-spawn";
import type { Exec } from "./types.js";

const TIMEOUT_MS = 20_000;

/**
 * Runs a CLI without a shell. cross-spawn handles Windows .cmd shims (az,
 * vercel) by escaping each argument, so values taken from the user's command
 * line (a --hostname, a --scope) can never be interpreted by cmd.exe.
 */
export const realExec: Exec = (bin, args, env) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, {
      env: { ...env, CLOUDPIN_ACTIVE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const notFound = err.code === "ENOENT";
      resolve({ code: notFound ? 127 : 1, stdout, stderr: err.message, notFound });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
