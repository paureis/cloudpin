import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { flagValue, hasAnyFlag, leadingWords } from "../args.js";
import type { Exec, ProviderDef, Resolution } from "../types.js";

// Behaviour below was observed on vercel 50.35 through `--debug` request URLs
// (HANDOFF.md, "Provider research"):
// - account-level requests use --scope/--team, else the global current team;
// - project-level requests use the linked project's orgId, overridden by
//   VERCEL_ORG_ID; a --team flag does not change the project lookup.
// A command may touch both, so both must be the pinned team.

const EXEMPT_COMMANDS = new Set(["login", "logout", "switch", "whoami", "help", "telemetry"]);
const EXEMPT_TEAMS_SUBCOMMANDS = new Set(["ls", "list", "switch"]);

interface Team {
  id: string;
  slug: string;
  current?: boolean;
}

/** Where `vercel login` may keep its credentials; only existence is checked. */
function loginDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const dirs: string[] = [];
  if (env.APPDATA) {
    // Docs say xdg.data; this machine's CLI actually uses Data.
    dirs.push(join(env.APPDATA, "com.vercel.cli", "Data"), join(env.APPDATA, "xdg.data", "com.vercel.cli"));
  }
  if (env.XDG_DATA_HOME) dirs.push(join(env.XDG_DATA_HOME, "com.vercel.cli"));
  dirs.push(
    join(home, ".local", "share", "com.vercel.cli"),
    join(home, "Library", "Application Support", "com.vercel.cli"),
  );
  return dirs;
}

function linkedOrg(dir: string): string | undefined {
  try {
    const link = JSON.parse(readFileSync(join(dir, ".vercel", "project.json"), "utf8")) as { orgId?: unknown };
    return typeof link.orgId === "string" ? link.orgId : undefined;
  } catch {
    return undefined;
  }
}

function failure(stderr: string, code: number, what: string): Resolution {
  const reason = /^Error: (.+)$/m.exec(stderr)?.[1]?.trim().slice(0, 300);
  return { kind: "error", message: reason ? `vercel: ${reason}` : `${what} failed (exit ${code})` };
}

export const vercel: ProviderDef<"vercel"> = {
  name: "vercel",
  bins: ["vercel", "vc"],
  statusCommand: "vercel whoami",

  isExempt(args) {
    if (hasAnyFlag(args, ["--version", "-v", "--help", "-h"])) return true;
    const [first, second] = leadingWords(args);
    if (first === undefined) return false;
    if (EXEMPT_COMMANDS.has(first)) return true;
    return first === "teams" && second !== undefined && EXEMPT_TEAMS_SUBCOMMANDS.has(second);
  },

  async resolve({ args, env, cwd }, exec) {
    const token = flagValue(args, ["--token", "-t"]);
    const globalConfig = flagValue(args, ["--global-config", "-Q"]);

    // Logged out, vercel waits for a login indefinitely (even non-interactive),
    // so detect that first from the presence of a token or a login file.
    const dirs = globalConfig ? [resolvePath(cwd, globalConfig)] : loginDirs(env);
    if (!token && !env.VERCEL_TOKEN && !dirs.some((d) => existsSync(join(d, "auth.json")))) {
      return { kind: "logged-out", hint: "vercel login" };
    }

    const common = ["--non-interactive"];
    if (token) common.push("--token", token);
    if (globalConfig) common.push("--global-config", globalConfig);

    const listed = await exec("vercel", ["teams", "ls", "--format", "json", ...common], env);
    if (listed.code !== 0) return failure(listed.stderr, listed.code, "vercel teams ls");
    let teams: Team[];
    try {
      teams = (JSON.parse(listed.stdout) as { teams: Team[] }).teams;
    } catch {
      return { kind: "error", message: "could not read vercel teams ls output" };
    }
    const toId = (value: string) => teams.find((t) => t.id === value || t.slug === value)?.id ?? value;
    const slugOf = (id: string) => teams.find((t) => t.id === id)?.slug ?? "";

    // The team account-level requests use.
    let team: string;
    const explicit = flagValue(args, ["--team", "-T", "--scope", "-S"]);
    if (explicit !== undefined) {
      team = toId(explicit);
    } else {
      const current = teams.find((t) => t.current);
      if (current) {
        team = current.id;
      } else {
        // No current team: the CLI uses the user's Hobby team.
        const user = await exec("vercel", ["api", "/v2/user", "--raw", ...common], env);
        if (user.code !== 0) return failure(user.stderr, user.code, "vercel api /v2/user");
        try {
          team = (JSON.parse(user.stdout) as { user: { defaultTeamId: string } }).user.defaultTeamId;
        } catch {
          return { kind: "error", message: "could not read vercel api /v2/user output" };
        }
      }
    }

    const identity: Record<string, string> = { team, label: slugOf(team) };
    // The team project-level requests use.
    const projectDir = resolvePath(cwd, flagValue(args, ["--cwd"]) ?? ".");
    const projectTeam = env.VERCEL_ORG_ID ?? linkedOrg(projectDir);
    if (projectTeam) identity.projectTeam = toId(projectTeam);
    return { kind: "identity", identity, source: "vercel teams ls" };
  },

  compare(pin, identity) {
    const out: string[] = [];
    if (identity.team !== pin.team) {
      const slug = identity.label ? ` (${identity.label})` : "";
      out.push(`team: expected "${pin.team}", active is "${identity.team}"${slug}`);
    }
    if (identity.projectTeam !== undefined && identity.projectTeam !== pin.team) {
      out.push(`linked project: belongs to team "${identity.projectTeam}", expected "${pin.team}"`);
    }
    return out;
  },

  switchHint(pin) {
    // `vercel switch [name]` takes a slug, so open the picker and name the ID.
    return `vercel switch (choose the team with ID ${pin.team})`;
  },
};
