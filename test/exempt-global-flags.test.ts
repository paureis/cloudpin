import { describe, expect, it } from "vitest";
import { aws } from "../src/providers/aws.js";
import { azure } from "../src/providers/azure.js";
import { gcloud } from "../src/providers/gcloud.js";
import { vercel } from "../src/providers/vercel.js";

// #21: a global flag (and its value) before the subcommand must not hide a
// login, logout, switch or whoami. Flag lists come from each CLI's own help.
const split = (cmd: string) => cmd.split(" ");

describe("exempt commands after global flags (#21)", () => {
  it.each([
    [aws, "--profile prod sso login"],
    [aws, "--region eu-west-1 configure sso"],
    [aws, "--output json --profile p sts get-caller-identity"],
    [azure, "--output table login"],
    [azure, "-o json --query x account set --subscription abc"],
    [gcloud, "--project p config set account a"],
    [gcloud, "--account me@x.com --verbosity debug auth login"],
    [vercel, "--scope team switch"],
    [vercel, "--token t0ken whoami"],
    [vercel, "-S team -Q ./cfg teams switch"],
  ] as const)("%#: %s is exempt", (provider, cmd) => {
    expect(provider.isExempt(split(cmd))).toBe(true);
  });

  it.each([
    [aws, "--profile login s3 rm s3://b/x"],
    [azure, "--output login vm delete -n x"],
    [gcloud, "--project config compute instances delete vm"],
    [vercel, "--scope switch deploy --prod"],
    [vercel, "--token login deploy"],
  ] as const)("%#: a flag value named like an exempt command is not the command: %s", (provider, cmd) => {
    expect(provider.isExempt(split(cmd))).toBe(false);
  });
});
