import { homedir } from "node:os";
import { join } from "node:path";

/** The user's home folder as the command's environment sees it. */
export function home(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? env.USERPROFILE ?? homedir();
}

/** Windows roaming app data, or undefined elsewhere. */
export function appData(env: NodeJS.ProcessEnv): string | undefined {
  return env.APPDATA;
}

/**
 * Where a bare command name resolves on PATH, without spawning anything. On
 * Windows only names with a PATHEXT extension run (`cloudpin.cmd`, not the
 * extensionless script npm also writes for Git Bash). Variable names are
 * matched case-insensitively there, since copies of the environment keep `Path`.
 */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: (path: string) => boolean,
): string | null {
  const get = (key: string) =>
    platform === "win32" ? Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1] : env[key];
  const dirs = (get("PATH") ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = platform === "win32" ? (get("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Where cloudpin keeps its identity cache. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLOUDPIN_CACHE_DIR) return env.CLOUDPIN_CACHE_DIR;
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "cloudpin", "cache");
  if (process.platform === "darwin") return join(home(env), "Library", "Caches", "cloudpin");
  return join(env.XDG_CACHE_HOME ?? join(home(env), ".cache"), "cloudpin");
}
