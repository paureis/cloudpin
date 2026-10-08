import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./tmp.js";
import { isReadOnly } from "../src/readonly.js";

const split = (cmd: string) => cmd.split(" ").filter(Boolean);
// A home folder with no AWS alias file, so the built-in AWS list applies.
const env = { HOME: tempDir("cloudpin-ro-home-"), USERPROFILE: "" };
const ro = (provider: Parameters<typeof isReadOnly>[0], cmd: string, rules = {}) =>
  isReadOnly(provider, split(cmd), env, rules);

describe("isReadOnly: built-in lists", () => {
  it.each([
    ["azure", "group list"],
    ["azure", "vm show -g rg -n web"],
    ["azure", "account show"],
    ["aws", "ec2 describe-instances --region eu-west-1"],
    ["aws", "s3api list-buckets"],
    ["aws", "sts get-caller-identity"],
    ["aws", "s3 ls s3://bucket"],
    ["gcloud", "compute instances list"],
    ["gcloud", "compute instances describe my-vm --zone x"],
    ["gcloud", "projects describe my-project"],
    ["gcloud", "run services list"],
    ["gcloud", "beta run services describe api"],
    ["vercel", "ls"],
    ["vercel", "list my-app"],
    ["vercel", "inspect https://x.vercel.app"],
    ["vercel", "logs https://x.vercel.app"],
    ["vercel", "env ls"],
    ["vercel", "domains list"],
    ["vercel", "project inspect web"],
    ["github", "pr list"],
    ["github", "pr view 12 --comments"],
    ["github", "issue status"],
    ["github", "run view 123 --log"],
    ["github", "status"],
  ] as const)("%s %s is read-only", (provider, cmd) => {
    expect(ro(provider, cmd)).toBe(true);
  });

  it.each([
    ["azure", "group delete -n rg"],
    ["azure", "rest --method get --url x"],
    ["azure", "list"],
    ["azure", ""],
    ["aws", "s3 cp a s3://b/a"],
    ["aws", "ec2 terminate-instances --instance-ids i-1"],
    ["aws", "--region eu-west-1 ec2 describe-instances"],
    ["gcloud", "compute instances delete my-vm"],
    ["gcloud", "compute instances delete describe"],
    ["gcloud", "compute instances stop list"],
    ["gcloud", "compute instances describe a b"],
    ["gcloud", "list"],
    ["vercel", ""],
    ["vercel", "deploy --prod"],
    ["vercel", "./site"],
    ["vercel", "alias"],
    ["vercel", "alias set a b"],
    ["vercel", "env pull"],
    ["vercel", "ls --yes"],
    ["vercel", "--scope team ls"],
    ["github", "pr merge 12"],
    ["github", "api user"],
    ["github", "mine list"],
    ["github", "pr"],
  ] as const)("%s %s needs confirmation", (provider, cmd) => {
    expect(ro(provider, cmd)).toBe(false);
  });

  it("treats every aws command as changing when an AWS CLI alias file exists", () => {
    // AWS CLI aliases can replace a built-in command (awscli/alias.py), so a
    // name like describe-instances may not mean what it says.
    const home = tempDir("cloudpin-ro-alias-");
    mkdirSync(join(home, ".aws", "cli"), { recursive: true });
    writeFileSync(join(home, ".aws", "cli", "alias"), "[toplevel]\n");
    expect(isReadOnly("aws", split("ec2 describe-instances"), { HOME: home }, {})).toBe(false);
  });
});

describe("isReadOnly: project rules", () => {
  it("extends the list with the project's read_only entries", () => {
    const rules = { azure: [["webapp", "log", "tail"]] };
    expect(ro("azure", "webapp log tail -g rg -n web", rules)).toBe(true);
    expect(ro("azure", "webapp log download", rules)).toBe(false);
  });

  it("only applies a rule to its own provider", () => {
    expect(ro("aws", "webapp log tail", { azure: [["webapp", "log", "tail"]] })).toBe(false);
  });
});
