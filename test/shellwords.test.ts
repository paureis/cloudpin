import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { commandName } from "../src/guard.js";
import { findInvocations } from "../src/shellwords.js";

const GUARDED = ["az", "aws", "gcloud", "vercel", "gh"];
const find = (cmd: string) => findInvocations(cmd, GUARDED);

describe("findInvocations", () => {
  it("finds a plain call", () => {
    expect(find("gh pr list")).toEqual([{ bin: "gh", args: ["pr", "list"], env: {} }]);
  });

  it("ignores commands that are not guarded", () => {
    expect(find("git push && npm test")).toEqual([]);
  });

  it("finds calls on both sides of && || ; | and newlines", () => {
    expect(find("az vm list && gh pr list || aws s3 ls; vercel ls | cat\ngh repo view").map((i) => i.bin)).toEqual([
      "az",
      "gh",
      "aws",
      "vercel",
      "gh",
    ]);
  });

  it("does not split on operators inside quotes", () => {
    expect(find(`gh pr create --title "a && b; c"`)).toEqual([
      { bin: "gh", args: ["pr", "create", "--title", "a && b; c"], env: {} },
    ]);
  });

  it("keeps leading VAR=value assignments as the call's env", () => {
    expect(find("AWS_PROFILE=prod CLOUDPIN_SKIP=1 aws s3 ls")).toEqual([
      { bin: "aws", args: ["s3", "ls"], env: { AWS_PROFILE: "prod", CLOUDPIN_SKIP: "1" } },
    ]);
  });

  it.each([
    ["npx vercel deploy", "vercel"],
    ["npx --yes vercel deploy", "vercel"],
    ["pnpm dlx vercel deploy", "vercel"],
    ["bunx vercel deploy", "vercel"],
    ["sudo az vm list", "az"],
    ["env AWS_PROFILE=x aws s3 ls", "aws"],
    ["command gh pr list", "gh"],
    ["time gh pr list", "gh"],
    ["nohup gh pr list", "gh"],
    ["/usr/local/bin/gh pr list", "gh"],
    ["'C:\\tools\\az.cmd' vm list", "az"],
    ["if true; then gh pr list; fi", "gh"],
  ])("sees through %j", (cmd, bin) => {
    // `bin` stays as written (paths included); the guard normalises it.
    expect(find(cmd).map((i) => commandName(i.bin))).toEqual([bin]);
  });

  it("looks inside bash -c and sh -c strings", () => {
    expect(find(`bash -c "cd x && gh pr list"`).map((i) => i.bin)).toEqual(["gh"]);
  });

  it("looks inside subshells, $( ) and backticks", () => {
    expect(find("(cd x; az vm list)").map((i) => i.bin)).toEqual(["az"]);
    expect(find("echo $(gh api user)").map((i) => i.bin)).toEqual(["gh"]);
    expect(find("echo `aws sts get-caller-identity`").map((i) => i.bin)).toEqual(["aws"]);
  });

  it("handles single quotes and escapes", () => {
    expect(find(`gh issue create --body 'it'"'"'s fine' --title a\\ b`)).toEqual([
      { bin: "gh", args: ["issue", "create", "--body", "it's fine", "--title", "a b"], env: {} },
    ]);
  });

  it("does not mistake an argument for a command", () => {
    expect(find("echo gh is great")).toEqual([]);
    expect(find("git commit -m 'use az later'")).toEqual([]);
  });

  it.each([
    ["timeout 30 gh pr list", ["pr", "list"]],
    ["timeout -s KILL 30s gh pr list", ["pr", "list"]],
    ["xargs -n 1 gh repo delete", ["repo", "delete"]],
    ["xargs -I {} gh repo view {}", ["repo", "view", "{}"]],
  ])("sees through %j", (cmd, args) => {
    expect(find(cmd)).toEqual([{ bin: "gh", args, env: {} }]);
  });
});

describe("findInvocations with cd", () => {
  const base = resolve("/work/app");

  it("checks a call after cd against the folder it moved to", () => {
    expect(findInvocations("cd ../other && vercel deploy", GUARDED, base)).toEqual([
      { bin: "vercel", args: ["deploy"], env: {}, cwd: resolve("/work/other") },
    ]);
  });

  it("follows an absolute cd and later cds", () => {
    const calls = findInvocations("cd /srv/a; gh pr list; cd b && az vm list", GUARDED, base);
    expect(calls.map((c) => c.cwd)).toEqual([resolve("/srv/a"), resolve("/srv/a/b")]);
  });

  it("leaves cwd unset when there is no cd", () => {
    expect(findInvocations("gh pr list", GUARDED, base)[0]?.cwd).toBeUndefined();
  });
});
