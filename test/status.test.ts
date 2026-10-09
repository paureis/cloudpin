import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { buildStatus, collectStatus } from "../src/status.js";
import type { ProviderDef, Resolution } from "../src/types.js";

function provider(name: "github" | "aws", res: Resolution): ProviderDef {
  return {
    name,
    bins: [name === "github" ? "gh" : "aws"],
    statusCommand: "x",
    cacheInputs: () => ({ env: [], files: [], dirs: [] }),
    isExempt: () => false,
    resolve: async () => res,
    compare: (pin: Record<string, string>, id) =>
      Object.entries(pin)
        .filter(([k, v]) => id[k] !== v)
        .map(([k, v]) => `${k}: expected "${v}", active is "${id[k]}"`),
    switchHint: () => "switch",
  } as ProviderDef;
}

const deps = (config: FoundConfig | null, providers: ProviderDef[]): GuardDeps => ({
  providers,
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  findConfig: () => config,
});

describe("collectStatus", () => {
  it("returns the same facts as structured data, for --json", async () => {
    const config = { path: "/repo/.cloudpin.yml", pins: { github: { user: "acme-bot" } } };
    const status = await collectStatus(
      deps(config, [
        provider("github", { kind: "identity", identity: { user: "me", host: "github.com" }, source: "t" }),
        provider("aws", { kind: "logged-out", hint: "aws login" }),
      ]),
      "/repo",
      {},
      () => ["claude (personal)"],
    );
    expect(status).toEqual({
      pinFile: "/repo/.cloudpin.yml",
      providers: [
        {
          name: "github",
          state: "active",
          identity: { user: "me", host: "github.com" },
          pin: { user: "acme-bot" },
          match: false,
          problems: ['user: expected "acme-bot", active is "me"'],
        },
        { name: "aws", state: "logged-out", hint: "aws login" },
      ],
      hooks: ["claude (personal)"],
    });
  });
});

describe("buildStatus", () => {
  it("shows each CLI's active account, its pin and whether they match", async () => {
    const config = { path: "/repo/.cloudpin.yml", pins: { github: { user: "acme-bot" } } };
    const lines = await buildStatus(
      deps(config, [
        provider("github", { kind: "identity", identity: { user: "me", host: "github.com" }, source: "t" }),
        provider("aws", { kind: "identity", identity: { account: "123", arn: "arn:x" }, source: "t" }),
      ]),
      "/repo",
      {},
      () => [],
    );
    expect(lines).toEqual([
      "Pin file: /repo/.cloudpin.yml",
      "",
      "  github  active: me (github.com)",
      '          pinned: acme-bot  ->  MISMATCH: user: expected "acme-bot", active is "me"',
      "  aws     active: 123 (arn:x)",
      "          not pinned here",
      "",
      "Agent hooks: none installed",
    ]);
  });

  it("reports logged-out, errors, missing CLIs and no pin file", async () => {
    const missing: ProviderDef = {
      ...provider("aws", { kind: "error", message: "x" }),
      resolve: async (_c, exec) => {
        await exec("aws", [], {});
        return { kind: "error", message: "aws failed" };
      },
    };
    const lines = await buildStatus(
      {
        ...deps(null, [provider("github", { kind: "logged-out", hint: "gh auth login" }), missing]),
        exec: async () => ({ code: 127, stdout: "", stderr: "", notFound: true }),
      },
      "/repo",
      {},
      () => ["claude (project)"],
    );
    expect(lines).toEqual([
      "Pin file: none here or in any parent folder",
      "",
      "  github  not logged in (gh auth login)",
      "  aws     not installed",
      "",
      "Agent hooks: claude (project)",
    ]);
  });
});

describe("status with environments", () => {
  const production = { name: "production", protected: true, source: 'branch "main"' };
  const config = { path: "/repo/.cloudpin.yml", pins: { github: { user: "me" } }, environment: production };
  const gh = provider("github", { kind: "identity", identity: { user: "me" }, source: "t" });

  it("includes the active environment in --json", async () => {
    const status = await collectStatus(deps(config, [gh]), "/repo", {}, () => []);
    expect(status.environment).toEqual(production);
  });

  it("shows the active environment, why it applies and that it is protected", async () => {
    const lines = await buildStatus(deps(config, [gh]), "/repo", {}, () => []);
    expect(lines.slice(0, 2)).toEqual([
      "Pin file: /repo/.cloudpin.yml",
      'Environment: production (protected: changing commands ask first), chosen by branch "main"',
    ]);
  });

  it("passes the environment variables to the config lookup", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    await collectStatus(
      { ...deps(config, [gh]), findConfig: (_cwd, env) => ((seen = env), config) },
      "/repo",
      { CLOUDPIN_ENV: "staging" },
      () => [],
    );
    expect(seen).toEqual({ CLOUDPIN_ENV: "staging" });
  });
});

describe("status for a CLI with nothing to target in this folder", () => {
  it("says so instead of 'could not tell'", async () => {
    const res: Resolution = { kind: "error", message: "no Supabase project for this command", noTarget: true };
    const status = await collectStatus(deps(null, [provider("github", res)]), "/repo", {}, () => []);
    expect(status.providers[0]).toEqual({ name: "github", state: "no-target", message: "no Supabase project for this command" });
    const lines = await buildStatus(deps(null, [provider("github", res)]), "/repo", {}, () => []);
    expect(lines.join("\n")).toMatch(/github {2}nothing in this folder says which one/);
  });
});
