import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, findConfig, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
  it("parses every provider section", () => {
    const pins = parseConfig(`
azure:
  subscription: 3f2a0000-0000-0000-0000-000000000c91 # "Prod"
  tenant: 8b1d0000-0000-0000-0000-00000000044e
aws:
  account: "123456789012"
gcloud:
  account: me@example.com
  project: my-project
vercel:
  team: team_x9K
github:
  user: paureis
`);
    expect(pins).toEqual({
      azure: {
        subscription: "3f2a0000-0000-0000-0000-000000000c91",
        tenant: "8b1d0000-0000-0000-0000-00000000044e",
      },
      aws: { account: "123456789012" },
      gcloud: { account: "me@example.com", project: "my-project" },
      vercel: { team: "team_x9K" },
      github: { user: "paureis" },
    });
  });

  it("keeps an unquoted numeric AWS account ID intact as a string", () => {
    expect(parseConfig("aws:\n  account: 012345678901\n")).toEqual({
      aws: { account: "012345678901" },
    });
  });

  it("returns an empty pin set for an empty file", () => {
    expect(parseConfig("")).toEqual({});
  });

  it("rejects an unknown provider, naming it", () => {
    expect(() => parseConfig("azur:\n  subscription: x\n")).toThrow(
      /unknown section "azur"/,
    );
  });

  it("rejects an unknown key inside a provider", () => {
    expect(() => parseConfig("vercel:\n  teem: x\n")).toThrow(
      /vercel: unknown key "teem"/,
    );
  });

  it("rejects a provider section missing its required key", () => {
    expect(() => parseConfig("azure:\n  tenant: x\n")).toThrow(
      /azure: "subscription" is required/,
    );
  });

  it("requires at least one of account or project for gcloud", () => {
    expect(() => parseConfig("gcloud: {}\n")).toThrow(
      /gcloud: set "account", "project" or both/,
    );
  });

  it("rejects malformed YAML with a ConfigError", () => {
    expect(() => parseConfig("azure: [unclosed\n")).toThrow(ConfigError);
  });
});

describe("findConfig", () => {
  function tree() {
    const root = mkdtempSync(join(tmpdir(), "cloudpin-"));
    const nested = join(root, "apps", "web");
    mkdirSync(nested, { recursive: true });
    return { root, nested };
  }

  it("finds the nearest .cloudpin.yml walking upward", () => {
    const { root, nested } = tree();
    writeFileSync(join(root, ".cloudpin.yml"), "github:\n  user: outer\n");
    writeFileSync(join(root, "apps", ".cloudpin.yml"), "github:\n  user: inner\n");
    const found = findConfig(nested);
    expect(found?.path).toBe(join(root, "apps", ".cloudpin.yml"));
    expect(found?.pins).toEqual({ github: { user: "inner" } });
  });

  it("returns null when no file exists up to the filesystem root", () => {
    const { nested } = tree();
    expect(findConfig(nested)).toBeNull();
  });

  it("reports the file path when the file is invalid", () => {
    const { root } = tree();
    writeFileSync(join(root, ".cloudpin.yml"), "nope:\n  x: 1\n");
    expect(() => findConfig(root)).toThrow(/\.cloudpin\.yml/);
  });
});
