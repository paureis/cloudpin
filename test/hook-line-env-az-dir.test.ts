import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calls, hook, SECRET } from "./hook-line-env-fixture.js";
import { tempDir } from "./tmp.js";

// AZURE_CONFIG_DIR picks the account, so a line may honestly set it, and the lookup must see it (rule 3). But az looks
// for extensions, which are Python it imports, under that folder or where its `config` file says (azure-cli-core
// extension/__init__.py), and imports all of them when its command index misses (core/__init__.py, load_command_table).
// A folder with neither is an account folder. From az's source alone: no real az runs here.
const CALL = "az group list";
const account = tempDir("cloudpin-az-account-");
const withExtensions = tempDir("cloudpin-az-ext-");
mkdirSync(join(withExtensions, "cliextensions"));
const withConfig = tempDir("cloudpin-az-config-");
writeFileSync(join(withConfig, "config"), "[core]\noutput = json\n\n[extension]\ndir = /elsewhere\n");
const withPlainConfig = tempDir("cloudpin-az-plain-config-");
writeFileSync(join(withPlainConfig, "config"), "[core]\noutput = json\n");

describe("a config folder the line chose", () => {
  it("that is only an account folder: the lookup starts with it", async () => {
    for (const dir of [account, withPlainConfig, join(account, "missing")]) {
      expect((await hook(`AZURE_CONFIG_DIR='${dir}' ${CALL}`)).decision).toBe("allow");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.env.AZURE_CONFIG_DIR).toBe(dir);
    }
  });

  it.each([
    ["extensions", withExtensions],
    ["a config file that names extensions", withConfig],
  ])("that holds %s: stops, starting nothing, without printing the folder", async (_, dir) => {
    const stopped = await hook(`AZURE_CONFIG_DIR='${dir}' ${CALL}`);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain("AZURE_CONFIG_DIR");
    expect(stopped.reason).toContain("can't tell");
    expect(stopped.reason).not.toContain(dir);
    expect(calls).toEqual([]);
  });

  it("written with a ~, which az expands itself", async () => {
    const user = tempDir("cloudpin-az-home-");
    mkdirSync(join(user, "other", "cliextensions"), { recursive: true });
    expect((await hook(`AZURE_CONFIG_DIR='~/other' ${CALL}`, { env: { HOME: user } })).decision).toBe("deny");
    expect(calls).toEqual([]);
    expect((await hook(`AZURE_CONFIG_DIR='~/none' ${CALL}`, { env: { HOME: user } })).decision).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("set in any case on Windows", async () => {
    const stopped = await hook(`$env:azure_config_dir='${withExtensions}'; ${CALL}`, { tool: "PowerShell", platform: "win32" });
    expect(stopped.decision).toBe("deny");
    expect(calls).toEqual([]);
  });

  it("set before the agent started is the user's, extensions and all", async () => {
    expect((await hook(CALL, { env: { AZURE_CONFIG_DIR: withExtensions } })).decision).toBe("allow");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.AZURE_CONFIG_DIR).toBe(withExtensions);
  });

  it("for another CLI it means nothing", async () => {
    expect((await hook(`AZURE_CONFIG_DIR='${withExtensions}' gh pr list`)).decision).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("only known when it runs: can't tell, as for any variable that picks the account", async () => {
    expect((await hook(`AZURE_CONFIG_DIR=$(cat ${SECRET}) ${CALL}`)).decision).toBe("deny");
    expect(calls).toEqual([]);
  });
});
