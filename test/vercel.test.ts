import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vercel } from "../src/providers/vercel.js";
import type { Exec } from "../src/types.js";

// Shapes observed from vercel 50.35.
const TEAMS = JSON.stringify({
  teams: [
    { id: "team_main", slug: "acme", name: "Acme", current: true },
    { id: "team_side", slug: "side", name: "Side", current: false },
  ],
  pagination: {},
});
const TEAMS_NONE_CURRENT = JSON.stringify({
  teams: [{ id: "team_side", slug: "side", name: "Side", current: false }],
});
const USER = JSON.stringify({ user: { id: "u1", username: "me", defaultTeamId: "team_hobby" } });

/** Fake vercel: answers `teams ls` and `api /v2/user`, recording calls. */
function fakeVercel(opts: { teams?: string; user?: string; fail?: { code: number; stderr: string } } = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    if (opts.fail) return { stdout: "", ...opts.fail };
    if (args[0] === "teams") return { code: 0, stdout: opts.teams ?? TEAMS, stderr: "" };
    if (args[0] === "api") return { code: 0, stdout: opts.user ?? USER, stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { exec, calls };
}

/** A temp folder with a Vercel login marker, optionally linked to a team. */
function folder(link?: string) {
  const dir = mkdtempSync(join(tmpdir(), "cloudpin-vercel-"));
  if (link) {
    mkdirSync(join(dir, ".vercel"));
    writeFileSync(join(dir, ".vercel", "project.json"), JSON.stringify({ orgId: link, projectId: "prj_1" }));
  }
  return dir;
}
const loggedIn = { VERCEL_TOKEN: "t0ken" };
const ctx = (args: string[], env: NodeJS.ProcessEnv = loggedIn, cwd = folder()) => ({ args, env, cwd });

describe("vercel.isExempt", () => {
  it.each([
    [["login"]],
    [["logout"]],
    [["switch", "acme"]],
    [["whoami"]],
    [["teams", "ls"]],
    [["teams", "switch", "acme"]],
    [["--version"]],
    [["-v"]],
    [["help"]],
    [["deploy", "--help"]],
  ])("allows %j", (args) => {
    expect(vercel.isExempt(args)).toBe(true);
  });

  // `link` can create a project in the active team, so it stays guarded.
  it.each([[["deploy", "--prod"]], [["env", "rm", "X"]], [["teams", "invite", "a@b.c"]], [["link"]], [[]]])(
    "guards %j",
    (args) => {
      expect(vercel.isExempt(args)).toBe(false);
    },
  );
});

describe("vercel.resolve", () => {
  it("uses the global current team when nothing overrides it", async () => {
    const { exec } = fakeVercel();
    expect(await vercel.resolve(ctx(["ls"]), exec)).toEqual({
      kind: "identity",
      identity: { team: "team_main", label: "acme" },
      source: "vercel teams ls",
    });
  });

  it("falls back to the Hobby team (defaultTeamId) when no team is current", async () => {
    const { exec } = fakeVercel({ teams: TEAMS_NONE_CURRENT });
    expect(await vercel.resolve(ctx(["ls"]), exec)).toMatchObject({ identity: { team: "team_hobby" } });
  });

  it("uses --scope <slug>, mapped to its ID", async () => {
    const { exec } = fakeVercel();
    expect(await vercel.resolve(ctx(["deploy", "--scope", "side"]), exec)).toMatchObject({
      identity: { team: "team_side", label: "side" },
    });
  });

  it.each([[["deploy", "-T", "team_side"]], [["deploy", "--team=side"]], [["deploy", "-S", "side"]]])(
    "uses %j",
    async (args) => {
      const { exec } = fakeVercel();
      expect(await vercel.resolve(ctx(args), exec)).toMatchObject({ identity: { team: "team_side" } });
    },
  );

  it("keeps an unknown --scope as-is so it cannot match by accident", async () => {
    const { exec } = fakeVercel();
    expect(await vercel.resolve(ctx(["deploy", "--scope", "nope"]), exec)).toMatchObject({
      identity: { team: "nope" },
    });
  });

  it("adds the linked project's team", async () => {
    const { exec } = fakeVercel();
    expect(await vercel.resolve(ctx(["deploy"], loggedIn, folder("team_side")), exec)).toMatchObject({
      identity: { team: "team_main", projectTeam: "team_side" },
    });
  });

  it("lets VERCEL_ORG_ID override the link", async () => {
    const { exec } = fakeVercel();
    const env = { ...loggedIn, VERCEL_ORG_ID: "team_main", VERCEL_PROJECT_ID: "prj_2" };
    expect(await vercel.resolve(ctx(["deploy"], env, folder("team_side")), exec)).toMatchObject({
      identity: { team: "team_main", projectTeam: "team_main" },
    });
  });

  it("honours --cwd for the link", async () => {
    const { exec } = fakeVercel();
    const linked = folder("team_side");
    expect(await vercel.resolve(ctx(["deploy", "--cwd", linked]), exec)).toMatchObject({
      identity: { projectTeam: "team_side" },
    });
  });

  it("passes --token, --global-config and a non-interactive flag to its own calls", async () => {
    const { exec, calls } = fakeVercel();
    await vercel.resolve(ctx(["ls", "--token", "abc", "-Q", "/cfg"], {}), exec);
    for (const call of calls) {
      expect(call).toContain("--non-interactive");
      expect(call.join(" ")).toContain("--token abc");
      expect(call.join(" ")).toContain("--global-config /cfg");
    }
  });

  it("reports logged-out without calling vercel when there is no login and no token", async () => {
    const { exec, calls } = fakeVercel();
    const empty = mkdtempSync(join(tmpdir(), "cloudpin-vercel-home-"));
    const res = await vercel.resolve(ctx(["ls"], { HOME: empty, APPDATA: empty, XDG_DATA_HOME: empty }), exec);
    expect(res).toEqual({ kind: "logged-out", hint: "vercel login" });
    expect(calls).toEqual([]);
  });

  it("passes vercel's error on", async () => {
    const { exec } = fakeVercel({ fail: { code: 1, stderr: "Error: Not authorized (403)\n" } });
    expect(await vercel.resolve(ctx(["ls"]), exec)).toEqual({
      kind: "error",
      message: "vercel: Not authorized (403)",
    });
  });
});

describe("vercel.compare", () => {
  it("matches when every team the command can touch is the pinned one", () => {
    expect(vercel.compare({ team: "team_main" }, { team: "team_main", projectTeam: "team_main" })).toEqual([]);
  });

  it("reports the active team, with its slug", () => {
    expect(vercel.compare({ team: "team_main" }, { team: "team_side", label: "side" })).toEqual([
      'team: expected "team_main", active is "team_side" (side)',
    ]);
  });

  it("reports a linked project that belongs to another team", () => {
    expect(vercel.compare({ team: "team_main" }, { team: "team_main", projectTeam: "team_side" })).toEqual([
      'linked project: belongs to team "team_side", expected "team_main"',
    ]);
  });

  it("suggests vercel switch", () => {
    // `vercel switch [name]` takes a team slug, not an ID, so open the picker and name the ID.
    expect(vercel.switchHint({ team: "team_main" })).toBe("vercel switch (choose the team with ID team_main)");
  });
});
