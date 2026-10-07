import { describe, expect, it } from "vitest";
import { ConfigError, type FoundConfig } from "../src/config.js";
import { guard, type GuardDeps } from "../src/guard.js";
import type { ProviderDef, Resolution } from "../src/types.js";

function fakeGithub(resolution: Resolution): ProviderDef<"github"> {
  return {
    name: "github",
    bins: ["gh"],
    isExempt: (args) => args[0] === "auth",
    resolve: async () => resolution,
    compare: (pin, id) => (pin.user === id.user ? [] : [`user: expected "${pin.user}", active is "${id.user}"`]),
    switchHint: (pin) => `gh auth switch --user ${pin.user}`,
  };
}

const pinned: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { github: { user: "paureis" } } };

function deps(resolution: Resolution, config: FoundConfig | null | Error = pinned): GuardDeps {
  return {
    providers: [fakeGithub(resolution)],
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    findConfig: () => {
      if (config instanceof Error) throw config;
      return config;
    },
  };
}

const me: Resolution = { kind: "identity", identity: { user: "paureis" }, source: "test" };
const other: Resolution = { kind: "identity", identity: { user: "someone" }, source: "test" };
const req = (bin: string, args: string[], extra: Partial<Parameters<typeof guard>[0]> = {}) => ({
  bin,
  args,
  env: {},
  cwd: "/repo/app",
  mode: "shell" as const,
  ...extra,
});

describe("guard", () => {
  it("allows CLIs it does not guard", async () => {
    expect(await guard(req("git", ["push"]), deps(other))).toEqual({ action: "allow", reason: "not-guarded" });
  });

  it("recognises guarded CLIs by path and Windows extension", async () => {
    const v = await guard(req("C:\\Program Files\\GitHub CLI\\GH.EXE", ["pr", "list"]), deps(other));
    expect(v.action).toBe("block");
  });

  it("allows everything when no .cloudpin.yml is found", async () => {
    expect(await guard(req("gh", ["pr", "list"]), deps(other, null))).toEqual({
      action: "allow",
      reason: "no-config",
    });
  });

  it("allows a CLI the config does not pin", async () => {
    const cfg = { path: "/repo/.cloudpin.yml", pins: { aws: { account: "1" } } };
    expect(await guard(req("gh", ["pr", "list"]), deps(other, cfg))).toEqual({
      action: "allow",
      reason: "not-pinned",
    });
  });

  it("allows exempt commands without resolving", async () => {
    expect(await guard(req("gh", ["auth", "switch"]), deps(other))).toEqual({ action: "allow", reason: "exempt" });
  });

  it("allows a matching identity", async () => {
    expect(await guard(req("gh", ["pr", "list"]), deps(me))).toEqual({ action: "allow", reason: "match" });
  });

  it("blocks a mismatch with the details and how to switch", async () => {
    expect(await guard(req("gh", ["pr", "list"]), deps(other))).toEqual({
      action: "block",
      provider: "github",
      configPath: "/repo/.cloudpin.yml",
      problems: ['user: expected "paureis", active is "someone"'],
      fix: "gh auth switch --user paureis",
    });
  });

  it("blocks when logged out, suggesting the login command", async () => {
    const v = await guard(req("gh", ["pr", "list"]), deps({ kind: "logged-out", hint: "gh auth login" }));
    expect(v).toMatchObject({ action: "block", problems: ["not logged in"], fix: "gh auth login" });
  });

  it("fails closed when the identity cannot be determined", async () => {
    const v = await guard(req("gh", ["pr", "list"]), deps({ kind: "error", message: "network down" }));
    expect(v).toMatchObject({ action: "block", problems: ["could not determine the active account: network down"] });
  });

  it("fails closed on an invalid config file", async () => {
    const v = await guard(req("gh", ["pr", "list"]), deps(me, new ConfigError("/repo/.cloudpin.yml: bad")));
    expect(v).toMatchObject({ action: "block", problems: ["invalid config: /repo/.cloudpin.yml: bad"] });
  });

  it("honours CLOUDPIN_SKIP=1 for humans", async () => {
    const v = await guard(req("gh", ["pr", "list"], { env: { CLOUDPIN_SKIP: "1" } }), deps(other));
    expect(v).toEqual({ action: "allow", reason: "skipped" });
  });

  it("ignores CLOUDPIN_SKIP in agent mode", async () => {
    const v = await guard(req("gh", ["pr", "list"], { env: { CLOUDPIN_SKIP: "1" }, mode: "agent" }), deps(other));
    expect(v.action).toBe("block");
  });
});
