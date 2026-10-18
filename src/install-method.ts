import { posix, win32 } from "node:path";

/*
 * How the running cloudpin was installed, so upgrade advice names the command
 * that actually upgrades it (#16, #17; docs/superpowers/specs/2026-10-17-installers-design.md).
 *
 * Decided from the real path of the running script, links followed: Homebrew
 * runs `bin/cloudpin`, a link into `Cellar/cloudpin/<version>/libexec/...`
 * (docs.brew.sh/Manpage, `brew --cellar`: `$(brew --prefix)/Cellar`, prefix
 * /opt/homebrew, /usr/local or /home/linuxbrew/.linuxbrew; `brew shellenv`
 * exports HOMEBREW_CELLAR). Scoop keeps apps in `<root>\apps\<app>\` under
 * $env:SCOOP (default ~\scoop) or $env:SCOOP_GLOBAL (default
 * $env:ProgramData\scoop). Anything else, including `npm install --global`
 * with Homebrew's node or Scoop's nodejs-lts, is npm.
 */

export type InstallMethod = "npm" | "brew" | "scoop";

const DEFAULT_CELLARS = ["/opt/homebrew/Cellar", "/usr/local/Cellar", "/home/linuxbrew/.linuxbrew/Cellar"];

/** True when `path` is inside `dir` (both already normalized the same way). */
function inside(path: string, dir: string, sep: string): boolean {
  const prefix = dir.endsWith(sep) ? dir : dir + sep;
  return path.startsWith(prefix);
}

/**
 * `script` is the running script's path (process.argv[1]); `realpath` follows
 * its links and may throw, in which case the path is used as given.
 */
export function installMethod(
  script: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  realpath: (path: string) => string,
): InstallMethod {
  if (script === "") return "npm";
  let real = script;
  try {
    real = realpath(script);
  } catch {
    // Keep the unresolved path.
  }
  if (platform === "win32") {
    // Windows variable names and paths are case-insensitive; copies of the environment keep `ProgramData`, `PROGRAMDATA`...
    const get = (key: string) => Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1];
    const norm = (p: string) => win32.normalize(p).toLowerCase();
    const profile = get("USERPROFILE");
    const programData = get("PROGRAMDATA");
    const roots = [
      get("SCOOP"),
      get("SCOOP_GLOBAL"),
      profile ? win32.join(profile, "scoop") : undefined,
      programData ? win32.join(programData, "scoop") : undefined,
    ].filter((r): r is string => Boolean(r));
    const path = norm(real);
    return roots.some((root) => inside(path, norm(win32.join(root, "apps", "cloudpin")), "\\")) ? "scoop" : "npm";
  }
  const cellars = [env.HOMEBREW_CELLAR, ...DEFAULT_CELLARS].filter((c): c is string => Boolean(c));
  const path = posix.normalize(real);
  return cellars.some((cellar) => inside(path, posix.join(posix.normalize(cellar), "cloudpin"), "/")) ? "brew" : "npm";
}

/** The command that upgrades cloudpin installed this way. */
export function upgradeCommand(method: InstallMethod): string {
  switch (method) {
    case "brew":
      return "brew upgrade cloudpin";
    case "scoop":
      return "scoop update cloudpin";
    case "npm":
      return "npm install --global cloudpin";
  }
}

/** How to reinstall cloudpin installed this way (Scoop has no reinstall command). */
export function reinstallCommand(method: InstallMethod): string {
  switch (method) {
    case "brew":
      return "brew reinstall cloudpin";
    case "scoop":
      return "scoop uninstall cloudpin, then scoop install cloudpin";
    case "npm":
      return "npm install --global cloudpin";
  }
}

/**
 * What to do when this cloudpin runs but none is on PATH. A brew or Scoop
 * install is there already, so the fix is its link or shim, and the folder
 * those live in being on PATH (`brew link`, `scoop reset` recreates shims).
 */
export function pathFix(method: InstallMethod): string {
  switch (method) {
    case "brew":
      return "brew link cloudpin, and check that Homebrew's bin folder ($(brew --prefix)/bin) is on PATH";
    case "scoop":
      return "scoop reset cloudpin, and check that Scoop's shims folder is on PATH";
    case "npm":
      return "npm install --global cloudpin";
  }
}
