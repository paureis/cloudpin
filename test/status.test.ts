import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { buildStatus } from "../src/status.js";
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
