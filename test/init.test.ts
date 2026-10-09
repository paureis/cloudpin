import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { addEnvironment, renderConfig, type FoundIdentity } from "../src/init.js";

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
    expect(parseConfig(renderConfig(found)).pins).toEqual({
      azure: { subscription: "3f2a-sub", tenant: "8b1d-ten" },
      aws: { account: "012345678901" },
      github: { user: "paureis" },
    });
  });

  it("pins a non-default GitHub host", () => {
    const text = renderConfig([{ provider: "github", identity: { user: "me", host: "ghe.corp.com" } }]);
    expect(parseConfig(text).pins).toEqual({ github: { user: "me", host: "ghe.corp.com" } });
  });

  it("keeps names with quotes or # safe inside comments", () => {
    const text = renderConfig([
      { provider: "azure", identity: { subscription: "s", tenant: "t", name: 'Dev "#1"\nx' } },
    ]);
    expect(parseConfig(text).pins).toEqual({ azure: { subscription: "s", tenant: "t" } });
    expect(text).toContain('# Dev "#1" x');
  });
});

describe("addEnvironment", () => {
  const prod: FoundIdentity[] = [
    { provider: "aws", identity: { account: "222222222222", arn: "arn:aws:iam::222222222222:user/me" } },
  ];
  const staging: FoundIdentity[] = [{ provider: "vercel", identity: { team: "team_staging", label: "Staging" } }];

  it("starts a new file in the environments format", () => {
    expect(addEnvironment(null, "production", true, prod, false)).toBe(
      [
        "# cloudpin: the cloud accounts this project uses. Commit this file.",
        "environments:",
        "  production:",
        "    protected: true",
        "    aws:",
        '      account: "222222222222" # arn:aws:iam::222222222222:user/me',
        "",
      ].join("\n"),
    );
  });

  it("adds an environment to an existing file, keeping its comments and layout", () => {
    const existing = [
      "# my notes",
      "environments:",
      "  staging:",
      '    vercel: { team: "team_staging" } # Staging',
      "branches:",
      "  main: production",
      "",
    ].join("\n");
    // The branch mapping names production before it exists; the file is only
    // valid once it is added, which is how people write it by hand too.
    const text = addEnvironment(existing.replace("main: production", "main: staging"), "production", true, prod, false);
    expect(text).toContain("# my notes");
    expect(text).toContain('vercel: { team: "team_staging" } # Staging');
    const project = parseConfig(text);
    expect(project.environments?.map((e) => [e.name, e.protected])).toEqual([
      ["staging", false],
      ["production", true],
    ]);
    expect(project.environments?.[1]?.pins).toEqual({ aws: { account: "222222222222" } });
  });

  it("refuses to replace an existing environment without force", () => {
    const text = addEnvironment(null, "staging", false, staging, false);
    expect(() => addEnvironment(text, "staging", false, prod, false)).toThrow(/"staging" already exists.*--force/);
    expect(parseConfig(addEnvironment(text, "staging", false, prod, true)).environments?.[0]?.pins).toEqual({
      aws: { account: "222222222222" },
    });
  });

  it("refuses the flat format, explaining how to convert it", () => {
    expect(() => addEnvironment('github:\n  user: "x"\n', "staging", false, staging, false)).toThrow(
      /flat format.*environments:/,
    );
  });

  it("treats an empty file like a new one", () => {
    expect(parseConfig(addEnvironment("# nothing yet\n", "dev", false, staging, false)).environments?.[0]?.name).toBe("dev");
  });

  it("rejects an invalid environment name", () => {
    expect(() => addEnvironment(null, "pro d", false, staging, false)).toThrow(/invalid environment name/);
  });
});

describe("renderConfig: kubernetes", () => {
  it("pins the server and an explicit namespace, with the context as a comment", () => {
    const found: FoundIdentity[] = [
      { provider: "kubernetes", identity: { server: "https://1.2.3.4", namespace: "payments", context: "prod-admin" } },
    ];
    expect(renderConfig(found)).toContain(
      ['kubernetes:', '  server: "https://1.2.3.4" # prod-admin', '  namespace: "payments"'].join("\n"),
    );
  });

  it("leaves the namespace out when it is just the default", () => {
    const found: FoundIdentity[] = [
      { provider: "kubernetes", identity: { server: "https://1.2.3.4", namespace: "default", context: "dev" } },
    ];
    expect(parseConfig(renderConfig(found)).pins).toEqual({ kubernetes: { server: "https://1.2.3.4" } });
  });
});
