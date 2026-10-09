import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReadOnly } from "../src/readonly.js";
import { supabase } from "../src/providers/supabase.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

const REF = "abcdefghijklmnopqrst";
const OTHER = "zyxwvutsrqponmlkjihg";
const BRANCH = "bbbbbbbbbbbbbbbbbbbb";

// Shape of `supabase projects list --output-format json` (apps/cli projects list handler).
const PROJECTS = JSON.stringify({
  projects: [
    { id: REF, organization_slug: "acme", name: "Acme prod", region: "eu-west-1", linked: true },
    { id: OTHER, organization_slug: "side", name: "Side", region: "us-east-1", linked: false },
  ],
});

function fake(opts: { code?: number; stdout?: string; stderr?: string } = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    return { code: opts.code ?? 0, stdout: opts.stdout ?? PROJECTS, stderr: opts.stderr ?? "" };
  };
  return { exec, calls };
}

/** A project folder like `supabase init` + `supabase link` leave it, with an optional subfolder. */
function project(ref?: string, linkedParent?: string) {
  const root = tempDir("cloudpin-supabase-");
  mkdirSync(join(root, "supabase", ".temp"), { recursive: true });
  writeFileSync(join(root, "supabase", "config.toml"), 'project_id = "local-stack"\n');
  if (ref) writeFileSync(join(root, "supabase", ".temp", "project-ref"), `${ref}\n`);
  if (linkedParent) {
    writeFileSync(
      join(root, "supabase", ".temp", "linked-project.json"),
      JSON.stringify({ ref: linkedParent, name: "Acme prod", organization_id: "org1", organization_slug: "acme" }),
    );
  }
  const sub = join(root, "functions", "hello");
  mkdirSync(sub, { recursive: true });
  return { root, sub };
}

const resolve = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}, exec: Exec = fake().exec) =>
  supabase.resolve({ args, env, cwd, bin: "supabase" }, exec);

describe("supabase.resolve: which project a command targets", () => {
  it("reads the linked ref from supabase/.temp/project-ref, walking up to supabase/config.toml", async () => {
    const { sub } = project(REF);
    expect(await resolve(["db", "push"], sub)).toEqual({
      kind: "identity",
      identity: { project: REF, org: "acme", name: "Acme prod" },
      source: "supabase/.temp/project-ref (supabase link)",
    });
  });

  it("lets SUPABASE_PROJECT_ID beat the linked ref, and --project-ref beat both", async () => {
    const { root } = project(REF);
    const env = { SUPABASE_PROJECT_ID: OTHER };
    expect(await resolve(["db", "push"], root, env)).toMatchObject({ identity: { project: OTHER }, source: "SUPABASE_PROJECT_ID" });
    expect(await resolve(["db", "push", "--project-ref", REF], root, env)).toMatchObject({ identity: { project: REF }, source: "--project-ref" });
    expect(await resolve(["db", "push", `--project-ref=${OTHER}`], root)).toMatchObject({ identity: { project: OTHER } });
  });

  it("honours --workdir and SUPABASE_WORKDIR instead of walking up", async () => {
    const linked = project(REF);
    const other = project(OTHER);
    expect(await resolve(["db", "push", "--workdir", other.root], linked.root)).toMatchObject({ identity: { project: OTHER } });
    expect(await resolve(["db", "push"], linked.root, { SUPABASE_WORKDIR: other.root })).toMatchObject({ identity: { project: OTHER } });
  });

  it("takes the project from `projects delete <ref>` and `gen types --project-id`", async () => {
    const { root } = project(REF);
    expect(await resolve(["projects", "delete", OTHER], root)).toMatchObject({ identity: { project: OTHER } });
    expect(await resolve(["gen", "types", "--project-id", OTHER], root)).toMatchObject({ identity: { project: OTHER } });
  });

  it("compares a linked branch by its parent project", async () => {
    const { root } = project(BRANCH, REF);
    expect(await resolve(["db", "push"], root)).toMatchObject({ identity: { project: REF, branch: BRANCH } });
  });

  it("stops when no project can be found, since the CLI would prompt or fail", async () => {
    const { root } = project();
    const res = await resolve(["db", "push"], root);
    expect(res).toMatchObject({ kind: "error", message: expect.stringMatching(/supabase link/) });
  });

  it("stops on a branch name in --project-ref, which only the API can map to a project", async () => {
    const { root } = project(REF);
    const res = await resolve(["link", "--project-ref", "feature-x"], root);
    expect(res).toMatchObject({ kind: "error", message: expect.stringMatching(/20 lowercase letters/) });
  });

  it("stops on a remote --db-url, which cloudpin can't tie to a project", async () => {
    const { root } = project(REF);
    const res = await resolve(["db", "push", "--db-url", "postgresql://u:secret@db.example.com:5432/postgres"], root);
    expect(res.kind).toBe("error");
    expect(JSON.stringify(res)).not.toContain("secret");
  });
});

describe("supabase.resolve: organisation", () => {
  it("adds the project's organisation from `projects list`", async () => {
    const { root } = project(REF);
    const { exec, calls } = fake();
    expect(await resolve(["db", "push"], root, {}, exec)).toMatchObject({ identity: { project: REF, org: "acme", name: "Acme prod" } });
    expect(calls).toEqual([["projects", "list", "--output-format", "json"]]);
  });

  it("passes --profile on, since tokens are stored per profile", async () => {
    const { root } = project(REF);
    const { exec, calls } = fake();
    await resolve(["--profile", "supabase-staging", "db", "push"], root, {}, exec);
    expect(calls[0]).toEqual(["projects", "list", "--output-format", "json", "--profile", "supabase-staging"]);
  });

  it("reports logged out, and a project the token can't see", async () => {
    const { root } = project(REF);
    const out = fake({ code: 1, stdout: "", stderr: "Access token not provided. Supply an access token by running supabase login or setting the SUPABASE_ACCESS_TOKEN environment variable." });
    expect(await resolve(["db", "push"], root, {}, out.exec)).toMatchObject({ kind: "logged-out", hint: "supabase login" });
    const none = fake({ stdout: JSON.stringify({ projects: [] }) });
    expect(await resolve(["db", "push"], root, {}, none.exec)).toMatchObject({ kind: "error", message: expect.stringMatching(/can't see project/) });
    const tokenVar = await resolve(["db", "push"], root, { SUPABASE_ACCESS_TOKEN: "sbp_x" }, none.exec);
    expect(JSON.stringify(tokenVar)).toContain("SUPABASE_ACCESS_TOKEN is set");
    expect(JSON.stringify(tokenVar)).not.toContain("sbp_x");
  });

  it("reads the message out of the CLI's JSON error (observed on 2.117 with a bad token)", async () => {
    const { root } = project(REF);
    const stderr =
      '{"_tag":"Error","error":{"code":"LegacyProjectsListUnexpectedStatusError","message":"Unexpected error retrieving projects: {\\"message\\":\\"Invalid access token\\"}"}}';
    const res = await resolve(["db", "push"], root, {}, fake({ code: 1, stdout: "", stderr }).exec);
    expect(res).toEqual({ kind: "error", message: 'Unexpected error retrieving projects: {"message":"Invalid access token"}' });
  });
});

describe("supabase.isExempt", () => {
  it.each([
    [["login"]], [["logout"]], [["link", "--project-ref", REF]], [["unlink"]], [["init"]], [["start"]], [["stop"]], [["status"]],
    [["functions", "serve"]], [["functions", "new", "hello"]], [["migration", "new", "x"]], [["db", "reset"]], [["db", "diff"]],
    [["migration", "up"]], [["--help"]], [["db", "push", "--help"]], [["--version"]], [["--workdir", "x", "start"]],
    [["db", "push", "--db-url", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"]],
  ])("exempts local or account-switching %j", (args) => {
    expect(supabase.isExempt(args)).toBe(true);
  });

  it.each([
    [["db", "push"]], [["db", "reset", "--linked"]], [["migration", "up", "--linked"]], [["functions", "deploy"]],
    [["secrets", "set", "A=1"]], [["gen", "types"]], [["db", "query", "select 1"]], [["projects", "delete", REF]],
    [["db", "push", "--db-url", "postgresql://u:p@db.example.com/postgres"]],
  ])("checks remote %j", (args) => {
    expect(supabase.isExempt(args)).toBe(false);
  });
});

describe("supabase.compare", () => {
  it("compares the project ref, and the organisation when pinned", () => {
    expect(supabase.compare({ project: REF }, { project: REF })).toEqual([]);
    expect(supabase.compare({ project: REF }, { project: OTHER })).toEqual([`project: pinned "${REF}", the command would use "${OTHER}"`]);
    expect(supabase.compare({ project: REF, org: "acme" }, { project: REF, org: "side" })).toEqual([`org: pinned "acme", the project is in "side"`]);
  });

  it("suggests linking the pinned project", () => {
    expect(supabase.switchHint({ project: REF })).toBe(`supabase link --project-ref ${REF}`);
  });
});

describe("read-only supabase commands on a protected environment", () => {
  it.each([
    [["projects", "list"]], [["functions", "list"]], [["secrets", "list"]], [["migration", "list"]], [["inspect", "db", "locks"]],
    [["branches", "list"]], [["gen", "types"]], [["--workdir", "x", "functions", "list"]],
  ])("trusts %j", (args) => {
    expect(isReadOnly("supabase", args, {}, {})).toBe(true);
  });

  it.each([[["db", "push"]], [["db", "query", "select 1"]], [["db", "pull"]], [["functions", "deploy"]], [["secrets", "set", "A=1"]], [["functions", "list", "deploy"]]])(
    "asks for %j",
    (args) => {
      expect(isReadOnly("supabase", args, {}, {})).toBe(false);
    },
  );
});
