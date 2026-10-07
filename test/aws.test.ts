import { describe, expect, it } from "vitest";
import { aws } from "../src/providers/aws.js";
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
const identityJson = JSON.stringify({
  UserId: "AIDAEXAMPLE",
  Account: "012345678901",
  Arn: "arn:aws:iam::012345678901:user/me",
});

describe("aws.isExempt", () => {
  it.each([
    [["configure"]],
    [["configure", "sso"]],
    [["sso", "login", "--profile", "p"]],
    [["sso", "logout"]],
    [["login"]],
    [["logout"]],
    [["sts", "get-caller-identity"]],
    [["--version"]],
    [["help"]],
    [["s3", "help"]],
  ])("allows %j", (args) => {
    expect(aws.isExempt(args)).toBe(true);
  });

  it.each([[["s3", "rm", "s3://b/k"]], [["sts", "assume-role"]], [["sso", "list-accounts"]], [[]]])(
    "guards %j",
    (args) => {
      expect(aws.isExempt(args)).toBe(false);
    },
  );
});

describe("aws.resolve", () => {
  it("reads the account from sts get-caller-identity", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: identityJson });
    const res = await aws.resolve(ctx(["s3", "ls"]), exec);
    expect(res).toEqual({
      kind: "identity",
      identity: { account: "012345678901", arn: "arn:aws:iam::012345678901:user/me" },
      source: "aws sts get-caller-identity",
    });
    expect(calls[0]?.args).toEqual(["sts", "get-caller-identity", "--output", "json"]);
  });

  it("passes the command's --profile to the identity call", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: identityJson });
    await aws.resolve(ctx(["s3", "ls", "--profile", "prod"]), exec);
    expect(calls[0]?.args).toEqual(["sts", "get-caller-identity", "--output", "json", "--profile", "prod"]);
  });

  it("passes the env through so AWS_PROFILE and key variables count", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: identityJson });
    await aws.resolve(ctx(["s3", "ls"], { AWS_PROFILE: "dev" }), exec);
    expect(calls[0]?.env.AWS_PROFILE).toBe("dev");
  });

  it("reports missing credentials (exit 253) as logged-out", async () => {
    const { exec } = fakeExec({
      code: 253,
      stderr: 'aws: [ERROR]: An error occurred (NoCredentials): Unable to locate credentials. You can configure credentials by running "aws login".',
    });
    expect((await aws.resolve(ctx(["s3", "ls"]), exec)).kind).toBe("logged-out");
  });

  it("reports an expired SSO session as logged-out with the profile in the hint", async () => {
    const { exec } = fakeExec({
      code: 255,
      stderr: "aws: [ERROR]: Error when retrieving token from sso: Token has expired and refresh failed",
    });
    expect(await aws.resolve(ctx(["s3", "ls", "--profile", "prod"]), exec)).toEqual({
      kind: "logged-out",
      hint: "aws sso login --profile prod",
    });
  });

  it("passes aws's own reason through for other failures", async () => {
    const { exec } = fakeExec({
      code: 255,
      stderr: "\naws: [ERROR]: The config profile (nope) could not be found\n",
    });
    expect(await aws.resolve(ctx(["s3", "ls", "--profile", "nope"]), exec)).toEqual({
      kind: "error",
      message: "aws: The config profile (nope) could not be found",
    });
  });
});

describe("aws.compare", () => {
  const identity = { account: "012345678901", arn: "arn:aws:iam::012345678901:user/me" };

  it("matches the pinned account", () => {
    expect(aws.compare({ account: "012345678901" }, identity)).toEqual([]);
  });

  it("reports a different account with the ARN for context", () => {
    expect(aws.compare({ account: "999999999999" }, identity)).toEqual([
      'account: expected "999999999999", active is "012345678901" (arn:aws:iam::012345678901:user/me)',
    ]);
  });

  it("suggests choosing a profile", () => {
    expect(aws.switchHint({ account: "999999999999" })).toBe(
      "set AWS_PROFILE (or pass --profile) to a profile for account 999999999999",
    );
  });
});
