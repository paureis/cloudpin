import { ConfigError, type FoundConfig, PROVIDERS } from "./config.js";
import { guard, type GuardDeps, installed } from "./guard.js";

/** One pinned provider's outcome. */
export type CheckStatus = "match" | "mismatch" | "not-logged-in" | "unknown" | "not-installed" | "unsupported";

/** `problems` and `fix` are the texts guard produces: never a credential value. */
export interface CheckEntry {
  provider: string;
  status: CheckStatus;
  problems: string[];
  fix?: string;
}

/** What `cloudpin check` found, printed as text or, with `--json`, as is (#10). */
export interface CheckReport {
  result: "match" | "mismatch" | "unpinned" | "error";
  path: string | null;
  environment: { name: string; protected: boolean; source: string } | null;
  /** An invalid pin file, or a bad `--only` list. */
  error?: string;
  /** Pinned providers, in PROVIDERS order (only the listed ones with `only`). */
  providers: CheckEntry[];
}

const NOT_SUPPORTED = "pinned, but not supported by this version of cloudpin yet";
const notInstalled = (bin: string) => `${bin} is not installed here`;

/**
 * Checks every pinned provider, or with `only` just the listed ones. With `only`
 * the check is strict, for CI: a listed provider must be pinned, installed and
 * logged in to the pinned account. Without it, a CLI that isn't installed has
 * nothing to check, as `cloudpin check` always did.
 */
export async function runCheck(
  cwd: string,
  env: NodeJS.ProcessEnv,
  deps: GuardDeps,
  opts: { only?: string[] } = {},
): Promise<CheckReport> {
  const fail = (error: string, config: FoundConfig | null = null): CheckReport => ({
    result: "error",
    path: config?.path ?? null,
    environment: environmentOf(config),
    error,
    providers: [],
  });

  let only: string[] | undefined;
  if (opts.only) {
    only = [...new Set(opts.only.map((name) => name.trim().toLowerCase()).filter((name) => name !== ""))];
    if (only.length === 0) return fail("--only names no provider");
    const unknown = only.find((name) => !(PROVIDERS as string[]).includes(name));
    if (unknown !== undefined) {
      return fail(`--only names "${unknown}", which is not a provider (expected one of: ${PROVIDERS.join(", ")})`);
    }
  }

  let config: FoundConfig | null;
  try {
    config = deps.findConfig(cwd, env);
  } catch (err) {
    if (err instanceof ConfigError) return fail(`invalid config: ${err.message}`);
    throw err;
  }
  if (!config) {
    if (only) return fail(`--only names ${only.join(", ")}, but no .cloudpin.yml was found here or in any parent folder`);
    return { result: "unpinned", path: null, environment: null, providers: [] };
  }
  if (only) {
    const unpinned = only.find((name) => !config.pins[name as keyof FoundConfig["pins"]]);
    if (unpinned !== undefined) {
      const where = config.environment ? ` (environment "${config.environment.name}")` : "";
      return fail(`--only names ${unpinned}, which is not pinned in ${config.path}${where}`, config);
    }
  }

  const providers: CheckEntry[] = [];
  for (const name of PROVIDERS) {
    if (!config.pins[name] || (only && !only.includes(name))) continue;
    const provider = deps.providers.find((p) => p.name === name);
    if (!provider) {
      providers.push({ provider: name, status: "unsupported", problems: [NOT_SUPPORTED] });
      continue;
    }
    const bin = provider.bins[0]!;
    // Strict only: a CLI found on no PATH entry fails, even for providers that
    // read their account from files without spawning it (#75).
    if (only && !installed(provider, env, deps.onPath)) {
      providers.push({ provider: name, status: "not-installed", problems: [notInstalled(bin)] });
      continue;
    }
    // "agent" mode so CLOUDPIN_SKIP cannot make a check report success.
    const verdict = await guard({ bin, args: [], env, cwd, mode: "agent" }, deps);
    if (verdict.action === "allow" && verdict.reason === "not-installed") {
      providers.push({ provider: name, status: "not-installed", problems: [notInstalled(bin)] });
    } else if (verdict.action === "allow" || verdict.action === "confirm") {
      // "confirm" means the account matches on a protected environment.
      providers.push({ provider: name, status: "match", problems: [] });
    } else {
      const status: CheckStatus = verdict.uncertain
        ? "unknown"
        : verdict.problems.length === 1 && verdict.problems[0] === "not logged in"
          ? "not-logged-in"
          : "mismatch";
      providers.push({
        provider: name,
        status,
        problems: verdict.problems,
        ...(verdict.fix !== undefined ? { fix: verdict.fix } : {}),
      });
    }
  }

  const has = (...statuses: CheckStatus[]) => providers.some((p) => statuses.includes(p.status));
  const result: CheckReport["result"] = has("unknown", "unsupported")
    ? "error"
    : has("mismatch", "not-logged-in") || (only && has("not-installed"))
      ? "mismatch"
      : "match";
  return { result, path: config.path, environment: environmentOf(config), providers };
}

function environmentOf(config: FoundConfig | null): CheckReport["environment"] {
  if (!config?.environment) return null;
  const { name, protected: isProtected, source } = config.environment;
  return { name, protected: isProtected, source };
}

/** 0 when everything pinned matches (or nothing is pinned), 1 otherwise. */
export const checkExitCode = (r: CheckReport): 0 | 1 => (r.result === "match" || r.result === "unpinned" ? 0 : 1);

/**
 * The text `cloudpin check` prints, line for line as before `--json` existed.
 * When `report.error` is set the single line belongs on stderr.
 */
export function formatCheckText(report: CheckReport): string[] {
  if (report.error !== undefined) return [`cloudpin: ${report.error}`];
  if (report.path === null) return ["cloudpin: no .cloudpin.yml found here or in any parent folder; nothing is pinned."];
  const lines = [`cloudpin: checking ${report.path}`];
  if (report.environment) {
    const { name, source } = report.environment;
    lines.push(`  environment: ${name}${report.environment.protected ? " (protected)" : ""}, chosen by ${source}`);
  }
  for (const { provider: name, status, problems, fix } of report.providers) {
    switch (status) {
      case "unsupported":
        lines.push(`  ? ${name}: ${problems[0] ?? NOT_SUPPORTED}`);
        break;
      case "not-installed":
        lines.push(`  -  ${name}: ${problems[0]}, nothing to check`);
        break;
      case "match":
        lines.push(`  ok ${name}: active account matches the pin`);
        break;
      case "unknown":
        lines.push(`  x  ${name}: could not tell which account is active, so commands will be stopped`);
        for (const problem of problems) lines.push(`     - reason: ${problem}`);
        if (fix) lines.push(`     to see what is wrong: ${fix}`);
        break;
      default:
        lines.push(`  x  ${name}`);
        for (const problem of problems) lines.push(`     - ${problem}`);
        if (fix) lines.push(`     fix: ${fix}`);
    }
  }
  return lines;
}
