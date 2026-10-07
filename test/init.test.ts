import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { renderConfig, type FoundIdentity } from "../src/init.js";

describe("renderConfig", () => {
  const found: FoundIdentity[] = [
    {
      provider: "azure" as const,
      identity: { subscription: "3f2a-sub", tenant: "8b1d-ten", name: "Acme Prod" },
    },
    { provider: "aws" as const, identity: { account: "012345678901", arn: "arn:aws:iam::012345678901:user/me" } },
    { provider: "github" as const, identity: { user: "paureis", host: "github.com" } },
  ];

  it("writes the pinned IDs with friendly names as comments", () => {
    expect(renderConfig(found)).toBe(
      [
        "# cloudpin: the cloud accounts this project uses. Commit this file.",
        "# Docs: https://github.com/paureis/cloudpin",
        "azure:",
        '  subscription: "3f2a-sub" # Acme Prod',
        '  tenant: "8b1d-ten"',
        "aws:",
        '  account: "012345678901" # arn:aws:iam::012345678901:user/me',
        "github:",
        '  user: "paureis"',
        "",
      ].join("\n"),
    );
  });

  it("produces a file that parses back to the same pins", () => {
    expect(parseConfig(renderConfig(found))).toEqual({
      azure: { subscription: "3f2a-sub", tenant: "8b1d-ten" },
      aws: { account: "012345678901" },
      github: { user: "paureis" },
    });
  });

  it("pins a non-default GitHub host", () => {
    const text = renderConfig([{ provider: "github", identity: { user: "me", host: "ghe.corp.com" } }]);
    expect(parseConfig(text)).toEqual({ github: { user: "me", host: "ghe.corp.com" } });
  });

  it("keeps names with quotes or # safe inside comments", () => {
    const text = renderConfig([
      { provider: "azure", identity: { subscription: "s", tenant: "t", name: 'Dev "#1"\nx' } },
    ]);
    expect(parseConfig(text)).toEqual({ azure: { subscription: "s", tenant: "t" } });
    expect(text).toContain('# Dev "#1" x');
  });
});
