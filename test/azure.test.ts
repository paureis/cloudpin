import { describe, expect, it } from "vitest";
import { azure } from "../src/providers/azure.js";
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

const SUB = "3F2A0000-0000-0000-0000-000000000C91";
const TENANT = "8b1d0000-0000-0000-0000-00000000044e";
const accountJson = JSON.stringify({
  id: SUB.toLowerCase(),
  tenantId: TENANT,
  name: "Prod",
  user: { name: "me@example.com", type: "user" },
});

describe("azure.isExempt", () => {
  it.each([
    [["login"]],
    [["logout"]],
    [["account", "set", "--subscription", "x"]],
    [["account", "show"]],
    [["account", "list"]],
    [["version"]],
    [["--version"]],
    [["vm", "list", "--help"]],
    [["vm", "-h"]],
  ])("allows %j", (args) => {
    expect(azure.isExempt(args)).toBe(true);
  });

  it.each([
    [["group", "delete", "-n", "rg"]],
    [["account", "get-access-token"]],
    [["webapp", "deploy"]],
    [[]],
  ])("guards %j", (args) => {
    expect(azure.isExempt(args)).toBe(false);
  });
});

describe("azure.resolve", () => {
  it("reads the default subscription from az account show", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: accountJson });
    const res = await azure.resolve(ctx(["group", "list"]), exec);
    expect(res).toEqual({
      kind: "identity",
      identity: { subscription: SUB.toLowerCase(), tenant: TENANT, name: "Prod" },
      source: "az account show",
    });
    expect(calls[0]?.args).toEqual(["account", "show", "--output", "json"]);
  });

  it("resolves the subscription named by the command's --subscription flag", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: accountJson });
    await azure.resolve(ctx(["group", "list", "--subscription", "Prod Sub"]), exec);
    expect(calls[0]?.args).toEqual([
      "account", "show", "--output", "json", "--subscription", "Prod Sub",
    ]);
  });

  it("supports --subscription=value", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: accountJson });
    await azure.resolve(ctx(["vm", "list", "--subscription=abc"]), exec);
    expect(calls[0]?.args).toContain("abc");
  });

  it("does not treat a subcommand's -s flag as a subscription", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: accountJson });
    await azure.resolve(ctx(["webapp", "deploy", "-s", "staging"]), exec);
    expect(calls[0]?.args).not.toContain("staging");
  });

  it("passes the env through so AZURE_CONFIG_DIR counts", async () => {
    const { exec, calls } = fakeExec({ code: 0, stdout: accountJson });
    await azure.resolve(ctx(["vm", "list"], { AZURE_CONFIG_DIR: "/other" }), exec);
    expect(calls[0]?.env.AZURE_CONFIG_DIR).toBe("/other");
  });

  it("reports logged-out when az asks for az login", async () => {
    const { exec } = fakeExec({ code: 1, stderr: "ERROR: Please run 'az login' to setup account." });
    expect((await azure.resolve(ctx(["vm", "list"]), exec)).kind).toBe("logged-out");
  });

  it("reports an unknown --subscription as an error", async () => {
    const { exec } = fakeExec({ code: 1, stderr: "ERROR: Subscription 'nope' not found." });
    const res = await azure.resolve(ctx(["vm", "list", "--subscription", "nope"]), exec);
    expect(res.kind).toBe("error");
  });

  it("passes az's own reason through, e.g. an ambiguous subscription name", async () => {
    const { exec } = fakeExec({
      code: 1,
      stderr:
        "ERROR: Multiple subscriptions with the name 'Azure subscription 1' found. Specify the subscription ID.\n",
    });
    const res = await azure.resolve(ctx(["vm", "list", "--subscription", "Azure subscription 1"]), exec);
    expect(res).toEqual({
      kind: "error",
      message:
        "az: Multiple subscriptions with the name 'Azure subscription 1' found. Specify the subscription ID.",
    });
  });

  it("reports unparseable output as an error", async () => {
    const { exec } = fakeExec({ code: 0, stdout: "not json" });
    expect((await azure.resolve(ctx(["vm", "list"]), exec)).kind).toBe("error");
  });
});

describe("azure.compare", () => {
  const identity = { subscription: SUB.toLowerCase(), tenant: TENANT, name: "Prod" };

  it("matches subscription GUIDs case-insensitively", () => {
    expect(azure.compare({ subscription: SUB }, identity)).toEqual([]);
  });

  it("checks the tenant only when pinned", () => {
    expect(azure.compare({ subscription: SUB, tenant: "other" }, identity)).toEqual([
      `tenant: expected "other", active is "${TENANT}"`,
    ]);
  });

  it("names the active subscription in a mismatch", () => {
    expect(azure.compare({ subscription: "aaaa" }, identity)).toEqual([
      `subscription: expected "aaaa", active is "${SUB.toLowerCase()}" (Prod)`,
    ]);
  });

  it("suggests az account set", () => {
    expect(azure.switchHint({ subscription: SUB })).toBe(`az account set --subscription ${SUB}`);
  });
});
