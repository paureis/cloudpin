import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard } from "../src/guard.js";
import { vercel } from "../src/providers/vercel.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #153 item 5. With services on, a command in a service's folder links the parent project's root, not
// the folder (vercel 50.35 packages/cli/src/util/projects/find-project-root.ts resolveProjectCwd):
// - the root is the nearest folder above with .vercel, vercel.json or .git (findProjectRoot);
// - services are on when VERCEL_USE_EXPERIMENTAL_SERVICES is "1" or "true" in any case, or that root's
//   vercel.json has experimentalServices (util/projects/detect-services.ts);
// - dev.ts calls it, and so do getLinkedProject (util/projects/link.ts), ensureLink
//   (util/link/ensure-link.ts) and build, so every command that reads a link goes through it, and dev
//   and ensureLink go through it twice.
// The default branch (vercel 65.4) adds vercel.toml as a marker, the `services` and
// `experimentalServicesV2` keys, and config files cloudpin can't read (vercel.toml, vercel.ts and so on).

const TEAMS = JSON.stringify({
  teams: [
    { id: "team_main", slug: "acme", current: true },
    { id: "team_side", slug: "side", current: false },
  ],
  pagination: {},
});

const fakeVercel: Exec = async (_bin, args) =>
  args[0] === "teams" ? { code: 0, stdout: TEAMS, stderr: "" } : { code: 1, stdout: "", stderr: "unexpected" };

const split = (cmd: string) => (cmd === "" ? [] : cmd.split(" "));

function link(dir: string, org: string): string {
  mkdirSync(join(dir, ".vercel"), { recursive: true });
  writeFileSync(join(dir, ".vercel", "project.json"), JSON.stringify({ orgId: org, projectId: `prj_${org}` }));
  return dir;
}

/** A folder linked to `rootTeam` with `services/api` inside, linked to team_main. */
function tree(rootTeam = "team_side", vercelJson?: unknown): { root: string; service: string } {
  const root = tempDir("cloudpin-vercel-services-");
  link(root, rootTeam);
  const service = link(join(root, "services", "api"), "team_main");
  if (vercelJson !== undefined) writeFileSync(join(root, "vercel.json"), JSON.stringify(vercelJson));
  return { root, service };
}

const SERVICES = { experimentalServices: { api: { entrypoint: "services/api" } } };

function check(cmd: string, cwd: string, env: NodeJS.ProcessEnv = {}) {
  const config: FoundConfig = { path: "/repo/.cloudpin.yml", pins: { vercel: { team: "team_main" } } };
  return guard(
    { bin: "vercel", args: split(cmd), env: { VERCEL_TOKEN: "example-env-token", ...env }, cwd, mode: "agent" },
    { providers: [vercel], exec: fakeVercel, findConfig: () => config },
  );
}

const ALLOW = { action: "allow", reason: "match" };

function expectWrongRoot(v: Awaited<ReturnType<typeof check>>) {
  expect(v.action).toBe("block");
  expect(v.action === "block" && v.problems.join(" ")).toContain('linked project: belongs to team "team_side"');
}

describe("services on: the parent project's link counts (#153)", () => {
  it.each(["dev", "develop", "deploy", "env ls", "pull", "build", "project inspect"])(
    "vercel %s in a service's folder, by vercel.json",
    async (cmd) => {
      const { service } = tree("team_side", SERVICES);
      expectWrongRoot(await check(cmd, service));
    },
  );

  it.each(["services/api", "./services/api"])("vercel dev %s from the root's folder", async (dir) => {
    const { root } = tree("team_side", SERVICES);
    expectWrongRoot(await check(`dev ${dir}`, root));
  });

  it("vercel --cwd <service> dev", async () => {
    const { root } = tree("team_side", SERVICES);
    expectWrongRoot(await check("--cwd services/api dev", root));
  });

  it.each(["1", "true", "TRUE", "True"])("VERCEL_USE_EXPERIMENTAL_SERVICES=%s, with no config", async (value) => {
    const { service } = tree();
    expectWrongRoot(await check("dev", service, { VERCEL_USE_EXPERIMENTAL_SERVICES: value }));
  });

  it.each([
    ["services", { services: { api: {} } }],
    ["experimentalServicesV2", { experimentalServicesV2: { api: {} } }],
    ["an empty experimentalServices", { experimentalServices: {} }],
  ])("%s in vercel.json", async (_name, json) => {
    const { service } = tree("team_side", json);
    expectWrongRoot(await check("dev", service));
  });

  it("services in the config the current CLI compiled, .vercel/vercel.json", async () => {
    const { root, service } = tree();
    writeFileSync(join(root, ".vercel", "vercel.json"), JSON.stringify({ services: { api: {} } }));
    expectWrongRoot(await check("dev", service));
  });

  it.each(["vercel.toml", "vercel.ts", "vercel.mts", "vercel.js", "vercel.mjs", "vercel.cjs"])(
    "a %s, which cloudpin can't read, may turn them on",
    async (file) => {
      const { root, service } = tree();
      writeFileSync(join(root, file), "");
      expectWrongRoot(await check("dev", service));
    },
  );

  it("a root found by .git or vercel.json alone, whose repo link is the wrong team", async () => {
    const root = tempDir("cloudpin-vercel-services-");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "vercel.json"), JSON.stringify(SERVICES));
    mkdirSync(join(root, ".vercel"));
    writeFileSync(
      join(root, ".vercel", "repo.json"),
      JSON.stringify({ orgId: "team_side", projects: [{ id: "prj", name: "p", directory: "." }] }),
    );
    const service = link(join(root, "services", "api"), "team_main");
    expectWrongRoot(await check("dev", service));
  });

  it("a root marked only by vercel.toml, under a repository link of the wrong team", async () => {
    const top = tempDir("cloudpin-vercel-services-");
    mkdirSync(join(top, ".vercel"));
    writeFileSync(
      join(top, ".vercel", "repo.json"),
      JSON.stringify({ orgId: "team_side", projects: [{ id: "prj", name: "p", directory: "." }] }),
    );
    const middle = join(top, "apps");
    mkdirSync(middle);
    writeFileSync(join(middle, "vercel.toml"), "");
    expectWrongRoot(await check("dev", link(join(middle, "api"), "team_main")));
  });

  it("goes up a second time, as dev and ensureLink do", async () => {
    const top = tempDir("cloudpin-vercel-services-");
    link(top, "team_side");
    writeFileSync(join(top, "vercel.json"), JSON.stringify(SERVICES));
    const middle = link(join(top, "apps"), "team_main");
    writeFileSync(join(middle, "vercel.json"), JSON.stringify(SERVICES));
    const service = link(join(middle, "api"), "team_main");
    expectWrongRoot(await check("dev", service));
  });
});

describe("controls (#153)", () => {
  it("the same tree with services on and the pinned team passes", async () => {
    const { service } = tree("team_main", SERVICES);
    expect(await check("dev", service)).toMatchObject(ALLOW);
  });

  it("a service's own wrong link still blocks", async () => {
    const { root } = tree("team_main", SERVICES);
    const service = link(join(root, "services", "web"), "team_side");
    expectWrongRoot(await check("dev", service));
  });

  it("a root with no link adds nothing", async () => {
    const root = tempDir("cloudpin-vercel-services-");
    writeFileSync(join(root, "vercel.json"), JSON.stringify(SERVICES));
    const service = link(join(root, "services", "api"), "team_main");
    expect(await check("dev", service)).toMatchObject(ALLOW);
  });

  it.each([
    ["no vercel.json", undefined],
    ["a vercel.json without services", { name: "x" }],
    ["experimentalServices set to null", { experimentalServices: null }],
    ["services set to null", { services: null }],
  ])("services off, %s: a monorepo's other project doesn't count", async (_name, json) => {
    const { service } = tree("team_side", json);
    expect(await check("dev", service)).toMatchObject(ALLOW);
    expect(await check("deploy", service)).toMatchObject(ALLOW);
  });

  it("a vercel.json Vercel can't parse reads as services off", async () => {
    const { root, service } = tree();
    writeFileSync(join(root, "vercel.json"), "{ not json");
    expect(await check("dev", service)).toMatchObject(ALLOW);
  });

  it("now.json doesn't turn them on: 50.35 doesn't read it here, and later versions refuse it", async () => {
    const { root, service } = tree();
    writeFileSync(join(root, "now.json"), JSON.stringify({ services: { api: {} } }));
    expect(await check("dev", service)).toMatchObject(ALLOW);
  });

  it.each(["0", "false", "yes", ""])("VERCEL_USE_EXPERIMENTAL_SERVICES=%s is off", async (value) => {
    const { service } = tree();
    expect(await check("dev", service, { VERCEL_USE_EXPERIMENTAL_SERVICES: value })).toMatchObject(ALLOW);
  });

  it.each([".git", ".vercel", "vercel.json"])("only the nearest marker counts: %s without services stops the walk", async (marker) => {
    const { root } = tree("team_side", SERVICES);
    const middle = join(root, "packages");
    mkdirSync(middle);
    if (marker === "vercel.json") writeFileSync(join(middle, marker), "{}");
    else mkdirSync(join(middle, marker));
    const service = link(join(middle, "api"), "team_main");
    expect(await check("dev", service)).toMatchObject(ALLOW);
  });

  it("the folder's own vercel.json doesn't turn services on for itself", async () => {
    const { service } = tree();
    writeFileSync(join(service, "vercel.json"), JSON.stringify(SERVICES));
    expect(await check("dev", service)).toMatchObject(ALLOW);
  });

  it("VERCEL_ORG_ID still replaces every link", async () => {
    const { service } = tree("team_side", SERVICES);
    expect(await check("dev", service, { VERCEL_ORG_ID: "team_main" })).toMatchObject(ALLOW);
  });

  it("names the variable, so a value known only when it runs is stopped (#86)", () => {
    expect(vercel.cacheInputs({}, "linux").env).toContain("VERCEL_USE_EXPERIMENTAL_SERVICES");
  });
});
