import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./tmp.js";
import { cachedExec, type CacheInputs } from "../src/cache.js";
import type { Exec } from "../src/types.js";

function setup(inputs: Partial<CacheInputs> = {}) {
  const dir = tempDir("cloudpin-cache-");
  const watched = join(dir, "profile.json");
  writeFileSync(watched, "{}");
  const watchedDir = join(dir, "sso");
  mkdirSync(watchedDir);
  let calls = 0;
  let now = 1_000_000;
  let result = { code: 0, stdout: "me", stderr: "" };
  const exec: Exec = async () => {
    calls++;
    return { ...result };
  };
  const full: CacheInputs = { env: ["AWS_PROFILE", "CLOUDSDK_*"], files: [watched], dirs: [watchedDir], ...inputs };
  const make = (env: NodeJS.ProcessEnv = {}) =>
    cachedExec(exec, full, { cacheDir: join(dir, "cache"), now: () => now, env });
  return {
    dir,
    watched,
    watchedDir,
    make,
    calls: () => calls,
    advance: (ms: number) => (now += ms),
    setResult: (r: typeof result) => (result = r),
  };
}

describe("cachedExec", () => {
  it("answers a repeated identical call from the cache", async () => {
    const t = setup();
    await t.make()("aws", ["sts", "get-caller-identity"], {});
    const second = await t.make()("aws", ["sts", "get-caller-identity"], {});
    expect(second.stdout).toBe("me");
    expect(t.calls()).toBe(1);
  });

  it("misses when the arguments differ", async () => {
    const t = setup();
    await t.make()("aws", ["sts", "get-caller-identity"], {});
    await t.make()("aws", ["sts", "get-caller-identity", "--profile", "prod"], {});
    expect(t.calls()).toBe(2);
  });

  it("misses when a relevant environment variable changes", async () => {
    const t = setup();
    await t.make()("aws", ["x"], { AWS_PROFILE: "dev" });
    await t.make()("aws", ["x"], { AWS_PROFILE: "prod" });
    expect(t.calls()).toBe(2);
  });

  it("matches environment variables by prefix", async () => {
    const t = setup();
    await t.make()("gcloud", ["x"], { CLOUDSDK_CORE_PROJECT: "a" });
    await t.make()("gcloud", ["x"], { CLOUDSDK_CORE_PROJECT: "b" });
    expect(t.calls()).toBe(2);
  });

  it("ignores environment variables that do not affect the account", async () => {
    const t = setup();
    await t.make()("aws", ["x"], { TERM: "a" });
    await t.make()("aws", ["x"], { TERM: "b" });
    expect(t.calls()).toBe(1);
  });

  it("misses when a watched file is modified (an account switch)", async () => {
    const t = setup();
    await t.make()("az", ["x"], {});
    utimesSync(t.watched, new Date(), new Date(Date.now() + 5000));
    await t.make()("az", ["x"], {});
    expect(t.calls()).toBe(2);
  });

  it("misses when a file appears in a watched folder", async () => {
    const t = setup();
    await t.make()("aws", ["x"], {});
    writeFileSync(join(t.watchedDir, "token.json"), "{}");
    await t.make()("aws", ["x"], {});
    expect(t.calls()).toBe(2);
  });

  it("misses when a watched file that did not exist is created", async () => {
    const t = setup();
    const later = join(t.dir, "later.json");
    const inputs = { env: [], files: [later], dirs: [] };
    const exec1 = cachedExec(async () => ({ code: 0, stdout: "a", stderr: "" }), inputs, {
      cacheDir: join(t.dir, "c2"),
      now: () => 1,
      env: {},
    });
    await exec1("az", ["x"], {});
    writeFileSync(later, "{}");
    let calls = 0;
    const exec2 = cachedExec(
      async () => {
        calls++;
        return { code: 0, stdout: "b", stderr: "" };
      },
      inputs,
      { cacheDir: join(t.dir, "c2"), now: () => 1, env: {} },
    );
    expect((await exec2("az", ["x"], {})).stdout).toBe("b");
    expect(calls).toBe(1);
  });

  it("expires entries after five minutes", async () => {
    const t = setup();
    await t.make()("aws", ["x"], {});
    t.advance(5 * 60 * 1000 + 1);
    await t.make()("aws", ["x"], {});
    expect(t.calls()).toBe(2);
  });

  it("never caches a failed call", async () => {
    const t = setup();
    t.setResult({ code: 4, stdout: "", stderr: "login" });
    await t.make()("gh", ["x"], {});
    await t.make()("gh", ["x"], {});
    expect(t.calls()).toBe(2);
  });

  it("never writes a token from the environment or the arguments to disk", async () => {
    const t = setup({ env: ["VERCEL_TOKEN"] });
    await t.make()("vercel", ["teams", "ls", "--token", "argsecret123"], { VERCEL_TOKEN: "envsecret456" });
    const file = readFileSync(join(t.dir, "cache", "identity-cache.json"), "utf8");
    expect(file).not.toContain("argsecret123");
    expect(file).not.toContain("envsecret456");
  });

  it("survives a corrupted cache file", async () => {
    const t = setup();
    await t.make()("aws", ["x"], {});
    writeFileSync(join(t.dir, "cache", "identity-cache.json"), "{not json");
    expect((await t.make()("aws", ["x"], {})).stdout).toBe("me");
    expect(t.calls()).toBe(2);
  });

  it("is switched off by CLOUDPIN_NO_CACHE=1", async () => {
    const t = setup();
    await t.make({ CLOUDPIN_NO_CACHE: "1" })("aws", ["x"], {});
    await t.make({ CLOUDPIN_NO_CACHE: "1" })("aws", ["x"], {});
    expect(t.calls()).toBe(2);
  });
});
