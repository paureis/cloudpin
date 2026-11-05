import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findConfig } from "../src/config.js";
import type { GuardDeps } from "../src/guard.js";
import { CLOUDPIN_INSTRUCTIONS, cloudpinHandler, cloudpinTools, type ToolContext } from "../src/mcp-tools.js";
import { providers } from "../src/providers/index.js";
import { runSwitch, type SwitchIO } from "../src/switch.js";
import type { Exec, ProviderDef } from "../src/types.js";
import { fakeDoctorHost } from "./fake-doctor-host.js";
import { tempDir } from "./tmp.js";

// #112: the plan `cloudpin switch --json` prints without --yes, as an MCP tool. Every ID and name here is made up.

const SUB = "11111111-1111-4111-8111-111111111111";
const OTHER_SUB = "22222222-2222-4222-8222-222222222222";
const TENANT = "33333333-3333-4333-8333-333333333333";
const OTHER_TENANT = "44444444-4444-4444-8444-444444444444";
const SERVER = "https://kube.example.test";
/** What a credential variable holds in these tests; it must never reach an answer. */
const FAKE_VALUE = "example-value-of-a-variable";

/** Every command `cloudpin switch` may run. The fake CLIs answer them, so a tool that ran one is seen. */
const SWITCHES = /auth switch|teams switch|config set|account set|use-context|set-context/;
/** The identity and listing reads a plan may use. */
const READS = /^(gh api user|gh auth status|az account (show|list)|aws sts get-caller-identity|gcloud config list|gcloud auth list)\b/;

interface Logins {
  ghUser?: string;
  ghAccounts?: unknown;
  azSub?: string;
  azTenant?: string;
  azList?: { id: string; tenantId: string }[];
  gcloudLogins?: string[];
}

/** Fake CLIs that record every call. */
function machine(logins: Logins = {}) {
  const calls: string[] = [];
  const exec: Exec = async (bin, args) => {
    const line = [bin, ...args].join(" ");
    calls.push(line);
    const ok = (value: unknown) => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
    if (SWITCHES.test(line)) return ok("");
    if (line.startsWith("gh api user")) return ok(`${logins.ghUser ?? "someone-else"}\n`);
    if (line.startsWith("gh auth status")) return ok(logins.ghAccounts ?? []);
    if (line.startsWith("az account show")) return ok({ id: logins.azSub ?? OTHER_SUB, tenantId: logins.azTenant ?? TENANT, name: "Other Subscription" });
    if (line.startsWith("az account list")) return ok(logins.azList ?? []);
    if (line.startsWith("gcloud config list")) return ok({ core: { account: "other@example.test", project: "other-project" } });
    if (line.startsWith("gcloud auth list")) return ok((logins.gcloudLogins ?? []).map((account) => ({ account })));
    if (line.startsWith("aws sts")) return ok({ Account: "999999999999", Arn: "arn:aws:iam::999999999999:user/x" });
    throw new Error(`unscripted: ${line}`);
  };
  return { calls, exec };
}

interface Line {
  provider: string;
  status: string;
  commands?: string[][];
  candidates?: string[];
  reason?: string;
}
interface Answer {
  note: string;
  result: string;
  path: string | null;
  environment: unknown;
  error?: string;
  plan: Line[];
  ran: unknown[];
  after: unknown;
}

/** A real folder with this pin file, the real providers and config reader, and fake CLIs. */
function project(pinFile: string | null, logins: Logins = {}, extraEnv: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = "linux", list = providers) {
  const dir = tempDir("cloudpin-mcp-plan-");
  if (pinFile !== null) writeFileSync(join(dir, ".cloudpin.yml"), pinFile);
  const env: NodeJS.ProcessEnv = { HOME: dir, USERPROFILE: dir, ...extraEnv };
  const m = machine(logins);
  const deps: GuardDeps = { providers: list, exec: m.exec, platform, findConfig };
  const ctx: ToolContext = {
    cwd: dir,
    env,
    read: () => null,
    isDir: (p) => statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
    doctor: fakeDoctorHost,
  };
  const tool = cloudpinTools(deps, ctx).find((t) => t.name === "cloudpin_switch_plan");
  const call = async (args: Record<string, unknown> = {}) => (await tool!.call(args)) as Answer;
  /** What `cloudpin switch --json` prints in this project, with or without --yes. */
  const terminal = async (yes: boolean) => {
    const out: string[] = [];
    const io: SwitchIO = { isTTY: false, ask: async () => "", out: (l) => out.push(l), err: (l) => out.push(l) };
    await runSwitch(dir, env, deps, { yes, json: true }, io);
    return JSON.parse(out[0]!) as Omit<Answer, "note">;
  };
  return { dir, env, deps, ctx, tool, call, terminal, calls: m.calls };
}

const GH_PIN = "github: { user: me }\n";
const AZ_PIN = `azure: { subscription: ${SUB}, tenant: ${TENANT} }\n`;
const AWS_PIN = 'aws: { account: "111111111111" }\n';
const ME_LOGGED_IN = [{ host: "github.com", login: "me", active: false }];
const SUB_KNOWN = [{ id: SUB, tenantId: TENANT }];
const line = (a: Answer, provider: string) => a.plan.find((l) => l.provider === provider)!;

function awsConfig() {
  const dir = tempDir("cloudpin-mcp-plan-aws-");
  const file = join(dir, "config");
  writeFileSync(file, "[profile dev]\nsso_account_id = 111111111111\n");
  return { dir, file };
}

/** A kubeconfig on context `other` (namespace `right`), with these contexts on the pinned server. */
function kubeconfig(names: string[]) {
  const file = join(tempDir("cloudpin-mcp-plan-kube-"), "config");
  const contexts = names.map((name) => `- name: ${name}\n  context: { cluster: c1 }\n`).join("");
  writeFileSync(
    file,
    `current-context: other\ncontexts:\n- name: other\n  context: { cluster: c2, namespace: right }\n${contexts}clusters:\n- name: c1\n  cluster: { server: ${SERVER} }\n- name: c2\n  cluster: { server: https://other.example.test }\n`,
  );
  return file;
}

describe("cloudpin_switch_plan: the tool", () => {
  it("is listed as read-only, with only an optional cwd", async () => {
    const { deps, ctx } = project(GH_PIN);
    const handle = cloudpinHandler(deps, ctx, "9.9.9");
    const list = JSON.parse((await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })))!);
    const tool = list.result.tools.find((t: { name: string }) => t.name === "cloudpin_switch_plan");
    expect(tool).toBeDefined();
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["cwd"]);
    expect(tool.inputSchema.required).toBeUndefined();
  });

  it("answers over tools/call with the JSON as text and as structured content", async () => {
    const { deps, ctx } = project(GH_PIN, { ghAccounts: ME_LOGGED_IN });
    const handle = cloudpinHandler(deps, ctx, "9.9.9");
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cloudpin_switch_plan", arguments: {} } };
    const res = JSON.parse((await handle(JSON.stringify(call)))!).result;
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
    expect(res.structuredContent.plan[0].status).toBe("run");
  });

  it("refuses a folder that doesn't exist, and a cwd that isn't a string", async () => {
    const { tool, dir } = project(GH_PIN);
    await expect(tool!.call({ cwd: join(dir, "nope") })).rejects.toThrow(/folder not found/);
    await expect(tool!.call({ cwd: 7 })).rejects.toThrow(/cwd must be a string/);
  });
});

describe("cloudpin_switch_plan: what it answers", () => {
  it("every pin matches: nothing to do", async () => {
    const a = await project(GH_PIN, { ghUser: "me" }).call();
    expect(a.result).toBe("match");
    expect(a.plan).toEqual([{ provider: "github", status: "ok" }]);
  });

  it("a mismatch: run lines, the same as `cloudpin switch --json` without --yes, plus the note", async () => {
    const { call, terminal } = project(AZ_PIN + GH_PIN, { ghAccounts: ME_LOGGED_IN, azList: SUB_KNOWN });
    const { note, ...rest } = await call();
    expect(typeof note).toBe("string");
    expect(rest).toEqual(await terminal(false));
    expect(rest.result).toBe("mismatch");
    expect(rest.plan).toEqual([
      { provider: "azure", status: "run", commands: [["az", "account", "set", "--subscription", SUB]] },
      { provider: "github", status: "run", commands: [["gh", "auth", "switch", "--hostname", "github.com", "--user", "me"]] },
    ]);
    expect(rest.ran).toEqual([]);
    expect(rest.after).toBeNull();
  });

  it("a missing login: a manual line with the login command, and no command to run", async () => {
    const gh = line(await project(GH_PIN, { ghAccounts: [] }).call(), "github");
    expect(gh.status).toBe("manual");
    expect(gh.commands).toBeUndefined();
    expect(gh.reason).toContain("gh auth login --hostname github.com");
  });

  it("a subscription this login doesn't know: a manual line naming the full pinned IDs", async () => {
    const az = line(await project(AZ_PIN, { azList: [] }).call(), "azure");
    expect(az.status).toBe("manual");
    expect(az.reason).toContain(SUB);
    expect(az.reason).toContain(`az login --tenant ${TENANT}`);
  });

  it("an override in the environment: the manual line names the variable, never its value", async () => {
    const a = await project(GH_PIN, { ghAccounts: ME_LOGGED_IN }, { GH_TOKEN: FAKE_VALUE }).call();
    expect(line(a, "github").status).toBe("manual");
    expect(line(a, "github").reason).toContain("unset GH_TOKEN");
    expect(JSON.stringify(a)).not.toContain(FAKE_VALUE);
  });

  it("no variable's value reaches the answer, for any provider's override line", async () => {
    const names = ["GH_TOKEN", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "VERCEL_TOKEN", "SUPABASE_ACCESS_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDSDK_CORE_PROJECT", "CLOUDSDK_CORE_ACCOUNT"];
    const env = Object.fromEntries(names.map((n) => [n, FAKE_VALUE]));
    const pins = `${AZ_PIN}${AWS_PIN}gcloud: { account: me@example.test, project: mine }\n${GH_PIN}`;
    const a = await project(pins, { ghAccounts: ME_LOGGED_IN, azList: SUB_KNOWN }, env).call();
    expect(line(a, "github").reason).toContain("unset GH_TOKEN and GITHUB_TOKEN");
    expect(line(a, "aws").reason).toContain("unset AWS_ACCESS_KEY_ID");
    expect(line(a, "gcloud").reason).toContain("unset CLOUDSDK_CORE_PROJECT");
    expect(JSON.stringify(a)).not.toContain(FAKE_VALUE);
  });

  it("a gcloud configuration whose name cloudpin won't pass on: named by its variable, not its value", async () => {
    const pin = "gcloud: { project: mine }\n";
    const a = await project(pin, {}, { CLOUDSDK_ACTIVE_CONFIG_NAME: "example value!" }).call();
    expect(line(a, "gcloud").status).toBe("manual");
    expect(line(a, "gcloud").reason).toContain("CLOUDSDK_ACTIVE_CONFIG_NAME");
    expect(JSON.stringify(a)).not.toContain("example value!");
  });

  it("AWS: no command exists, so the line says what to set by hand, with the profile's name", async () => {
    const aws = line(await project(AWS_PIN, {}, { AWS_CONFIG_FILE: awsConfig().file }).call(), "aws");
    expect(aws.status).toBe("manual");
    expect(aws.reason).toContain("export AWS_PROFILE=dev");
  });

  it("several matching kube contexts: a choose line with the candidates, and how to pick", async () => {
    const { call, terminal } = project(`kubernetes: { server: ${SERVER} }\n`, {}, { KUBECONFIG: kubeconfig(["one", "two"]) });
    const { note: _note, ...rest } = await call();
    expect(rest).toEqual(await terminal(false));
    const kube = rest.plan[0]!;
    expect(kube.status).toBe("choose");
    expect(kube.candidates).toEqual(["one", "two"]);
    expect(kube.commands).toBeUndefined();
    expect(kube.reason).toContain("cloudpin switch in a terminal");
  });

  it("no pin file: nothing is pinned, and the plan is empty", async () => {
    const a = await project(null).call();
    expect(a).toMatchObject({ result: "unpinned", path: null, environment: null, plan: [], ran: [], after: null });
    expect(a.note).toMatch(/nothing was run/i);
  });

  it("a broken pin file: the error in the answer, as `cloudpin switch --json` gives it", async () => {
    const { call, terminal } = project("github: [not, a, mapping]\n");
    const { note: _note, ...rest } = await call();
    expect(rest.result).toBe("error");
    expect(rest.error).toMatch(/invalid config/);
    expect(rest).toEqual(await terminal(false));
  });

  it("uses the active environment of the pin file", async () => {
    const a = await project("environments:\n  staging:\n    github: { user: stage-bot }\n", { ghAccounts: [{ host: "github.com", login: "stage-bot", active: false }] }).call();
    expect(a.environment).toMatchObject({ name: "staging" });
    expect(line(a, "github").commands).toEqual([["gh", "auth", "switch", "--hostname", "github.com", "--user", "stage-bot"]]);
  });
});

describe("cloudpin_switch_plan: Windows, where a variable's name has no case (#119, #136)", () => {
  it("gh_token is the override there, and its value stays out; control: another variable elsewhere", async () => {
    const win = await project(GH_PIN, { ghAccounts: ME_LOGGED_IN }, { gh_token: FAKE_VALUE }, "win32").call();
    expect(line(win, "github").status).toBe("manual");
    expect(line(win, "github").reason).toContain("unset GH_TOKEN");
    expect(JSON.stringify(win)).not.toContain(FAKE_VALUE);

    const linux = await project(GH_PIN, { ghAccounts: ME_LOGGED_IN }, { gh_token: FAKE_VALUE }, "linux").call();
    expect(line(linux, "github").status).toBe("run");
  });

  it("a lowercase cloudpin_env picks the environment there", async () => {
    const pins = "environments:\n  staging:\n    github: { user: stage-bot }\n  production:\n    github: { user: me }\n";
    const a = await project(pins, { ghAccounts: ME_LOGGED_IN }, { cloudpin_env: "production" }, "win32").call();
    expect(a.environment).toMatchObject({ name: "production" });
  });
});

describe("cloudpin_switch_plan: nothing runs (#15: no tool will ever switch accounts)", () => {
  const PINS = `${AZ_PIN}gcloud: { account: me@example.test, project: mine }\n${GH_PIN}`;
  const LOGINS: Logins = { ghAccounts: ME_LOGGED_IN, azList: SUB_KNOWN, gcloudLogins: ["me@example.test"] };

  it("control: `cloudpin switch --yes` runs each switch command through these fake CLIs, and the pattern sees them", async () => {
    const { calls, terminal } = project(PINS, LOGINS);
    const json = await terminal(true);
    expect(json.ran).toHaveLength(4);
    expect(calls.filter((c) => SWITCHES.test(c))).toHaveLength(4);
  });

  it("the plan has those same commands, and the fake CLIs saw only identity reads", async () => {
    const { calls, call } = project(PINS, LOGINS);
    const a = await call();
    expect(a.plan.flatMap((l) => l.commands ?? [])).toHaveLength(4);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => SWITCHES.test(c))).toEqual([]);
    expect(calls.filter((c) => !READS.test(c))).toEqual([]);
    expect(a.ran).toEqual([]);
    expect(a.after).toBeNull();
  });

  it("writes nothing: no file in the folder, and nothing to CLOUDPIN_ENV_FILE for AWS", async () => {
    const { dir: aws, file } = awsConfig();
    const { call, dir } = project(AWS_PIN, {}, { AWS_CONFIG_FILE: file, CLOUDPIN_ENV_FILE: join(aws, "side") });
    const before = readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
    await call();
    expect(readdirSync(dir, { recursive: true, encoding: "utf8" }).sort()).toEqual(before);
    expect(readdirSync(aws)).toEqual(["config"]);
  });
});

describe("cloudpin_switch_plan: account IDs", () => {
  /** gh lists the pinned login as active, but the API answers as another: the plan repeats guard's mismatch. */
  const stillOther = { ghUser: "someone-else", ghAccounts: [{ host: "github.com", login: "me", active: true }] };

  it("shortens what the active login said, keeps the pin whole; control: the terminal's --json has it in full", async () => {
    const { call, terminal } = project(GH_PIN, stillOther);
    const reason = line(await call(), "github").reason!;
    expect(reason).toContain('expected "me"');
    expect(reason).toContain("…else");
    expect(reason).not.toContain("someone-else");
    expect((await terminal(false)).plan[0]!.reason).toContain("someone-else");
  });

  it("a subscription in another tenant: the login's tenant shortened, the pinned IDs whole", async () => {
    const { call, terminal } = project(AZ_PIN, { azList: [{ id: SUB, tenantId: OTHER_TENANT }] });
    const reason = line(await call(), "azure").reason!;
    expect(reason).toContain(SUB);
    expect(reason).toContain(TENANT);
    expect(reason).not.toContain(OTHER_TENANT);
    expect(reason).toContain("…4444");
    expect((await terminal(false)).plan[0]!.reason).toContain(OTHER_TENANT);
  });

  /** The real GitHub provider, comparing with the words given. */
  const github = (compare: string[]): ProviderDef[] => [{ ...providers.find((p) => p.name === "github")!, compare: () => compare } as ProviderDef];

  it("keeps a value that identifies nobody (github.com), as doctor does", async () => {
    const list = github(['host: active is "github.com"']);
    const reason = line(await project(GH_PIN, stillOther, {}, "linux", list).call(), "github").reason!;
    expect(reason).toBe('host: active is "github.com"');
  });

  it("shortens only the whole value: a pinned ID that contains the active one stays runnable", async () => {
    const list = github(['user: expected "me-and-others", active is "me"; me again, and me.']);
    const accounts = [{ host: "github.com", login: "me-and-others", active: true }];
    const reason = line(await project("github: { user: me-and-others }\n", { ghUser: "me", ghAccounts: accounts }, {}, "linux", list).call(), "github").reason!;
    expect(reason).toBe('user: expected "me-and-others", active is "…"; … again, and ….');
  });

  it("never shortens a command, even one that holds a value the active login also has", async () => {
    // The active context's namespace is `right`, the name of the context to move to.
    const pin = `kubernetes: { server: ${SERVER} }\n`;
    const a = await project(pin, {}, { KUBECONFIG: kubeconfig(["right"]) }).call();
    expect(line(a, "kubernetes").commands).toEqual([["kubectl", "config", "use-context", "right"]]);
  });
});

describe("cloudpin_switch_plan: a plan is for the user to run", () => {
  it("the description says nothing runs, the user runs them, and not to run them", () => {
    const { description } = project(GH_PIN).tool!;
    expect(description).toMatch(/nothing is run/i);
    expect(description).toMatch(/for the user to run/i);
    expect(description).toMatch(/never run them yourself/i);
  });

  it("the answer says so too, also for a command neither a hook nor cloudpin_check would stop", async () => {
    const { note } = await project(GH_PIN, { ghAccounts: ME_LOGGED_IN }).call();
    expect(note).toMatch(/nothing was run/i);
    expect(note).toMatch(/show it to them/i);
    expect(note).toMatch(/do not run its commands yourself/i);
    expect(note).toContain("cloudpin_check");
    expect(note).toMatch(/hook/i);
  });

  it("the answer says that a line saying 'yourself' speaks to the user, not the agent", async () => {
    const a = await project(GH_PIN, { ghAccounts: "not a list" }).call();
    expect(line(a, "github").reason).toContain("switch yourself");
    expect(a.note).toMatch(/addressed to the user/i);
  });

  it("the server's instructions say to show a plan and never run it, leaving the first 512 characters as they were", () => {
    expect(CLOUDPIN_INSTRUCTIONS).toMatch(/cloudpin_switch_plan[^.]*for the user to run/i);
    expect(CLOUDPIN_INSTRUCTIONS).toMatch(/show them, and never run them yourself/i);
    expect(CLOUDPIN_INSTRUCTIONS.slice(0, 512)).toMatch(/never runs or switches anything/i);
  });
});
