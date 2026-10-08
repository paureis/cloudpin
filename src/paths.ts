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

/** Where cloudpin keeps its identity cache. */
export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLOUDPIN_CACHE_DIR) return env.CLOUDPIN_CACHE_DIR;
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "cloudpin", "cache");
  if (process.platform === "darwin") return join(home(env), "Library", "Caches", "cloudpin");
  return join(env.XDG_CACHE_HOME ?? join(home(env), ".cache"), "cloudpin");
}
