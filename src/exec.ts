import type { StdioOptions } from "node:child_process";
import spawn from "cross-spawn";
import { isExecutableFile, resolveCommand } from "./paths.js";
import type { Exec } from "./types.js";

const TIMEOUT_MS = 20_000;

/**
 * The absolute file to spawn for `bin`, from the PATH in `env` (the command's
 * own environment), never from the current folder: given a bare name, the
 * `which` lookup inside cross-spawn, cmd.exe and libuv all search the current
 * folder first on Windows (GHSA-3cf7-5v5w-q5vr, CWE-427). Spawning the full
 * path leaves nothing for them to search.
 */
function resolveBin(bin: string, env: NodeJS.ProcessEnv): string | null {
  return resolveCommand(bin, env, process.platform, isExecutableFile);
}

const notFoundMessage = (bin: string) => `${bin}: not found on PATH`;

const NO_CWD_SEARCH = "NoDefaultCurrentDirectoryInExePath";

/**
 * The environment a child process gets. On Windows it also sets
 * NoDefaultCurrentDirectoryInExePath, which makes cmd.exe and libuv skip the
 * current folder when they look up a bare command name (Microsoft docs for
 * NeedCurrentDirectoryForExePathW; libuv src/win/process.c). Spawning the full
 * path only covers the first step: npm's .cmd shims (vercel, wrangler) then run
 * a bare `node` when no node.exe sits beside the shim, and that lookup happens
 * inside the child (GHSA-3cf7-5v5w-q5vr). Windows variable names are
 * case-insensitive and Node keeps only one key per name, chosen by sort order,
 * so any other casing is dropped before the canonical key is set.
 */
export function childEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const upper = NO_CWD_SEARCH.toUpperCase();
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() !== upper) out[k] = v;
  }
  out[NO_CWD_SEARCH] = "1";
  return out;
}

/**
 * What cmd.exe would act on if `file` were spawned with `args`, as a kind of character and never a value. cross-spawn
 * runs everything but a .com or .exe through cmd.exe (its lib/parse.js) and escapes each argument for that one reading.
 * A .cmd or .bat reads its `%*` a second time, without the carets, and the program then parses the line by other rules.
 * What follows was measured on printers shaped like the real az.cmd and npm's cmd-shim; only these change what arrives:
 *
 * - each word goes in double quotes and its own `"` becomes `\"`, but `\"` still toggles for cmd.exe, so & | < > ^ and
 *   ) can end up outside the quotes (`)` closes az.cmd's `IF ( )`). The count carries into the next word. A `"` that
 *   leaves none of them outside arrives intact, which is what keeps JMESPath such as `[?a=="b c"]` working;
 * - a line break cuts the line, or is dropped, in any .cmd;
 * - two or more backslashes before a `"` or at the end of a word are miscounted by cross-spawn, so the word changes or
 *   takes in the flags after it;
 * - `%NAME:a=b%` expands in the first reading, before any quote counts, with NAME's text unescaped (also built-in names
 *   no environment shows: CD, CMDCMDLINE). Plain `%NAME%` stays literal only because its closing `%` gets a caret, which
 *   makes the name `NAME^`, so it expands if a variable is named that;
 * - npm's cmd-shim expands COMSPEC and PATHEXT without quotes.
 */
export function cmdWouldAct(file: string, args: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== "win32" || /\.(?:com|exe)$/i.test(file)) return undefined;
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if ((upper === "COMSPEC" || upper === "PATHEXT") && value !== undefined && /[&|<>^"\r\n]/.test(value)) return `the value of ${upper}`;
  }
  const line = [file, ...args].join(" ");
  if (/[\r\n]/.test(line)) return "a line break";
  if (/%[^%:]*:[^%]*=[^%]*%/.test(line)) return "a %NAME:a=b% form";
  if (/%[^%]+%/.test(line) && Object.keys(env).some((name) => name.endsWith("^"))) return "%NAME%, with a variable whose name ends in ^";
  let quoted = false;
  for (const arg of args) {
    if (/\\\\(?:"|$)/.test(arg)) return "two backslashes before a double quote or at the end of a value";
    for (const c of `"${arg}"`) {
      if (c === '"') quoted = !quoted;
      else if (!quoted && "&|<>^)".includes(c)) return `a ${c} that a double quote leaves outside the quotes`;
    }
  }
  return undefined;
}

const refusal = (what: string) =>
  `not run: on Windows this command goes through cmd.exe (a .cmd or .bat file), which would act on ${what} and change the command. Give the value without it, run the CLI's .exe, or run the command yourself.`;

/**
 * Runs a CLI without a shell. cross-spawn handles Windows .cmd shims (az,
 * vercel) by escaping each argument, so values taken from the user's command
 * line (a --hostname, a --scope) can never be interpreted by cmd.exe.
 */
export const realExec: Exec = (bin, args, env) =>
  new Promise((resolve) => {
    const file = resolveBin(bin, env);
    if (file === null) {
      resolve({ code: 127, stdout: "", stderr: notFoundMessage(bin), notFound: true });
      return;
    }
    const what = cmdWouldAct(file, args, env);
    if (what !== undefined) {
      // az and gcloud providers pass on what follows "ERROR: " (see src/providers).
      resolve({ code: 1, stdout: "", stderr: `ERROR: ${refusal(what)}` });
      return;
    }
    const child = spawn(file, args, {
      env: childEnv({ ...env, CLOUDPIN_ACTIVE: "1" }),
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

/**
 * Runs the user's command for `cloudpin exec`, resolved the same way as
 * realExec, and returns its exit code (127 when it can't be started). It gets
 * the same childEnv, so on Windows the command's own lookups skip the current
 * folder too, as PowerShell and Git Bash already do. `cmdWouldAct` refuses here too.
 */
export function runInherited(bin: string, args: string[], env: NodeJS.ProcessEnv, stdio: StdioOptions = "inherit"): Promise<number> {
  return new Promise((resolve) => {
    const file = resolveBin(bin, env);
    if (file === null) {
      console.error(`cloudpin exec: ${notFoundMessage(bin)}`);
      resolve(127);
      return;
    }
    const what = cmdWouldAct(file, args, env);
    if (what !== undefined) {
      console.error(`cloudpin exec: ${refusal(what)}`);
      resolve(127);
      return;
    }
    const child = spawn(file, args, { env: childEnv(env), stdio });
    child.on("error", (err) => {
      console.error(`cloudpin exec: ${err.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
