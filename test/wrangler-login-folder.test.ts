import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cachedExec } from "../src/cache.js";
import { cloudflare } from "../src/providers/cloudflare.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #136: the identity cache keys `wrangler whoami` on Wrangler's login file,
// <global config folder>/config/default.toml. The folder is ~/.wrangler if it
// exists, else the XDG one, which differs per platform (workers-sdk
// packages/workers-utils/src/global-wrangler-config-path.ts getGlobalConfigPath
// and xdg-app-paths.ts xdgConfig): XDG_CONFIG_HOME when non-empty, else
// %APPDATA%\xdg.config on Windows, ~/Library/Preferences on macOS, ~/.config elsewhere.

const login = (dir: string) => join(dir, ".wrangler", "config", "default.toml");
const files = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => cloudflare.cacheInputs(env, platform).files;

describe("cloudflare.cacheInputs: the login file Wrangler writes, per platform (#136)", () => {
  const home = "/home/u";

  it("watches %APPDATA%\\xdg.config\\.wrangler on win32", () => {
    const appData = join("C:", "Users", "u", "AppData", "Roaming");
    expect(files({ USERPROFILE: home, APPDATA: appData }, "win32")).toEqual([login(home), login(join(appData, "xdg.config"))]);
    // Without APPDATA, Wrangler falls back to <home>\AppData\Roaming (windowsAppData).
    expect(files({ USERPROFILE: home }, "win32")).toEqual([login(home), login(join(home, "AppData", "Roaming", "xdg.config"))]);
  });

  it("watches ~/Library/Preferences/.wrangler on darwin", () => {
    expect(files({ HOME: home }, "darwin")).toEqual([login(home), login(join(home, "Library", "Preferences"))]);
  });

  it("watches ~/.config/.wrangler on linux", () => {
    expect(files({ HOME: home }, "linux")).toEqual([login(home), login(join(home, ".config"))]);
  });

  it("follows a non-empty XDG_CONFIG_HOME on every platform, and ignores an empty one", () => {
    const xdg = "/x/config";
    for (const platform of ["win32", "darwin", "linux"] as const) {
      expect(files({ HOME: home, APPDATA: "/a", XDG_CONFIG_HOME: xdg }, platform), platform).toEqual([login(home), login(xdg)]);
    }
    // xdg-portable's valOrPath: an empty value counts as unset.
    expect(files({ HOME: home, XDG_CONFIG_HOME: "" }, "linux")).toEqual([login(home), login(join(home, ".config"))]);
  });
});

describe("identity cache: a re-login in the Windows folder drops the cached whoami (#136)", () => {
  it("asks whoami again after %APPDATA%\\xdg.config\\.wrangler\\config\\default.toml changes", async () => {
    const appData = tempDir("cloudpin-wrangler-appdata-");
    const env = { USERPROFILE: tempDir("cloudpin-wrangler-home-"), APPDATA: appData };
    const file = login(join(appData, "xdg.config"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "oauth_token = \"first\"\n");
    let calls = 0;
    const exec: Exec = async () => ({ code: 0, stdout: String(++calls), stderr: "" });
    const cached = cachedExec(exec, cloudflare.cacheInputs(env, "win32"), { cacheDir: tempDir("cloudpin-wrangler-cache-"), env: {} });
    await cached("wrangler", ["whoami", "--json"], env);
    await cached("wrangler", ["whoami", "--json"], env);
    expect(calls).toBe(1);
    // `wrangler login` rewrites the file, with a different size, so the stamp changes.
    writeFileSync(file, "oauth_token = \"second, longer\"\n");
    await cached("wrangler", ["whoami", "--json"], env);
    expect(calls).toBe(2);
  });
});
