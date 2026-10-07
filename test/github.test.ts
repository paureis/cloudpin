import { describe, expect, it } from "vitest";
import { github } from "../src/providers/github.js";
import type { Exec } from "../src/types.js";

function fakeExec(result: { code: number; stdout?: string; stderr?: string }) {
  const calls: { bin: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const exec: Exec = async (bin, args, env) => {
    calls.push({ bin, args, env });
    return { stdout: "", stderr: "", ...result };
  };
  return { exec, calls };
}

const ctx = (args: string[], env: NodeJS.ProcessEnv = {}) => ({ args, env, cwd: "/repo" });

describe("github.isExempt", () => {
  it.each([
    [["auth", "switch", "--user", "x"]],
    [["auth", "login"]],
    [["auth", "status"]],
    [["--version"]],
    [["version"]],
    [["help", "pr"]],
    [["pr", "create", "--help"]],
    [["completion", "-s", "bash"]],
  ])("allows %j", (args) => {
    expect(github.isExempt(args)).toBe(true);
  });

  it.each([[["pr", "create"]], [["repo", "delete", "x"]], [["api", "user"]], [[]]])(
    "guards %j",
    (args) => {
      expect(github.isExempt(args)).toBe(false);
    },
  );
});

describe("github.resolve", () => {
  it("asks the API who the active credentials belong to", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: "paureis\n" });
    const res = await github.resolve(ctx(["pr", "list"]), exec);
    expect(res).toEqual({
      kind: "identity",
      identity: { user: "paureis", host: "github.com" },
      source: "gh api user",
    });
    expect(calls[0]?.args).toEqual(["api", "user", "--hostname", "github.com", "--jq", ".login"]);
  });

  it("uses GH_HOST for the host, and passes the env through so GH_TOKEN counts", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: "work-me\n" });
    const env = { GH_HOST: "ghe.corp.com", GH_TOKEN: "t" };
    const res = await github.resolve(ctx(["pr", "list"], env), exec);
    expect(res).toMatchObject({ identity: { user: "work-me", host: "ghe.corp.com" } });
    expect(calls[0]?.args).toContain("ghe.corp.com");
    expect(calls[0]?.env.GH_TOKEN).toBe("t");
  });

  it("uses an explicit --hostname flag over GH_HOST", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: "x\n" });
    await github.resolve(ctx(["api", "--hostname", "ghe.a.com", "user"], { GH_HOST: "ghe.b.com" }), exec);
    expect(calls[0]?.args).toContain("ghe.a.com");
  });

  it("reports logged-out when gh has no credentials", async () => {
    const { exec } = fakeExec({
      code: 4,
      stderr: "To get started with GitHub CLI, please run:  gh auth login",
    });
    const res = await github.resolve(ctx(["pr", "list"]), exec);
    expect(res.kind).toBe("logged-out");
  });

  it("reports other failures as errors without echoing env values", async () => {
    const { exec } = fakeExec({ code: 1, stderr: "HTTP 401: Bad credentials" });
    const res = await github.resolve(ctx(["pr", "list"], { GH_TOKEN: "secret-value" }), exec);
    expect(res.kind).toBe("error");
    expect(JSON.stringify(res)).not.toContain("secret-value");
  });
});

describe("github.compare", () => {
  it("matches logins case-insensitively", () => {
    expect(github.compare({ user: "PauReis" }, { user: "paureis", host: "github.com" })).toEqual([]);
  });

  it("reports a different user", () => {
    expect(github.compare({ user: "paureis" }, { user: "other", host: "github.com" })).toEqual([
      'user: expected "paureis", active is "other"',
    ]);
  });

  it("defaults the pinned host to github.com", () => {
    expect(github.compare({ user: "me" }, { user: "me", host: "ghe.corp.com" })).toEqual([
      'host: expected "github.com", active is "ghe.corp.com"',
    ]);
  });

  it("suggests gh auth switch", () => {
    expect(github.switchHint({ user: "paureis" })).toBe("gh auth switch --user paureis");
  });
});
