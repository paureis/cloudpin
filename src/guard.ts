import { basename } from "node:path";
import { type ActiveEnvironment, ConfigError, findConfig, type FoundConfig, type Provider } from "./config.js";
import { envNameMatches } from "./cache.js";
import { cmdReread, dynamicTarget, UNKNOWN_CWD, UNKNOWN_ENV } from "./dynamic-args.js";
import { codeVarsSet, codeVarsStop, lineMovedPath, PATH_ONLY_ON_LINE, withHooksPath } from "./line-code-env.js";
import { isReadOnly } from "./readonly.js";
import { type Exec, type ProviderDef, type Resolution, UNKNOWN_FOLDER, UNKNOWN_VALUE } from "./types.js";

export interface GuardRequest {
  /** The executable as typed or resolved, e.g. "az" or "C:\\...\\gh.exe". */
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** With `cwd` UNKNOWN_FOLDER: the last folder the line knew, where the search for a pin file starts (#163). */
  knownCwd?: string;
  /** Something earlier on the line may have set any variable, which cloudpin can't read (#163). */
  envUnknown?: boolean;
  /** What cmd.exe would act on in this call's command line, as a class of character (#168). */
  cmdReread?: string;
  /**
   * The environment the line starts in, when cloudpin read the call from a line: what `env` changes from it, the line
   * set. Absent for `cloudpin exec`, whose whole environment is the person's.
   */
  before?: NodeJS.ProcessEnv;
  /** "agent" ignores CLOUDPIN_SKIP and CLOUDPIN_CONFIRM, so an agent cannot opt itself out. */
  mode: "shell" | "agent";
}

export interface GuardDeps {
  providers: ProviderDef[];
  exec: Exec;
  /** Finds the pin file and selects its environment (`env` carries CLOUDPIN_ENV). */
  findConfig: (cwd: string, env: NodeJS.ProcessEnv) => FoundConfig | null;
  /** Optional wrapper around `exec` per provider, e.g. the identity cache. */
  wrapExec?: (provider: ProviderDef, env: NodeJS.ProcessEnv, exec: Exec) => Exec;
  /**
   * Finds a command on `env`'s PATH. `status`, `doctor` and the MCP tools use it to call a CLI
   * not installed when none of its commands is found, since some providers never spawn it (#75).
   */
  onPath?: (bin: string, env: NodeJS.ProcessEnv) => string | null;
  /** The platform the command runs on; on win32 variable names are case-insensitive. Defaults to this process's. */
  platform?: NodeJS.Platform;
}

/**
 * The command's environment as a Windows program reads it: one upper-case key
 * per name, since Windows and every guarded CLI there ignore case (Node's
 * process.env, Wrangler's caseInsensitiveEnv, Go's os.Getenv, Python's
 * os.environ) (#119). When two spellings differ, the value is the one of the
 * first key in code-unit order, the one Node keeps when it spawns
 * (child_process normalizeSpawnArguments), except that an unknown value wins;
 * `conflicts` names those variables, as which value a CLI sees then depends
 * on the shell and the CLI. Other platforms get `env` unchanged.
 */
export function foldEnvNames(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { env: NodeJS.ProcessEnv; conflicts: Map<string, string[]> } {
  const conflicts = new Map<string, string[]>();
  if (platform !== "win32") return { env, conflicts };
  const out: NodeJS.ProcessEnv = {};
  const spellings = new Map<string, string[]>();
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    if (value === undefined) continue;
    const name = key.toUpperCase();
    const seen = spellings.get(name);
    if (seen === undefined) {
      spellings.set(name, [key]);
      out[name] = value;
      continue;
    }
    seen.push(key);
    if (value === out[name]) continue;
    if (value === UNKNOWN_VALUE || out[name] === UNKNOWN_VALUE) out[name] = UNKNOWN_VALUE;
    else conflicts.set(name, seen);
  }
  return { env: out, conflicts };
}

/** Whether a call of `name` is one that never acts on an account, for the line reader (#163). */
export const exemptCall = (providers: ProviderDef[]) => (name: string, args: string[]): boolean =>
  providers.find((p) => p.bins.includes(name))?.isExempt(args, name) ?? false;

/** False only when `onPath` is given and finds none of the provider's commands. */
export function installed(provider: ProviderDef, env: NodeJS.ProcessEnv, onPath?: GuardDeps["onPath"]): boolean {
  return !onPath || provider.bins.some((bin) => onPath(bin, env) !== null);
}

export type Verdict =
  | {
      action: "allow";
      reason:
        | "not-guarded"
        | "no-config"
        | "not-pinned"
        | "exempt"
        | "match"
        | "skipped"
        | "confirmed"
        | "not-installed";
    }
  | {
      action: "block";
      /** True when the account could not be determined at all (a safety stop). */
      uncertain?: boolean;
      provider?: Provider;
      configPath?: string;
      environment?: ActiveEnvironment;
      problems: string[];
      fix?: string;
    }
  | {
      /** Right account, but a protected environment and a command that may change it. */
      action: "confirm";
      provider: Provider;
      configPath: string;
      environment: ActiveEnvironment;
    };

/** Normalises "C:\\x\\GH.EXE" or "/usr/bin/az" to "gh" / "az". */
export function commandName(bin: string): string {
  return basename(bin.replace(/\\/g, "/"))
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/**
 * What guard found on the way to its verdict, for `cloudpin explain`. guard
 * fills in what it gets to; the verdict never depends on it.
 */
export interface Trace {
  provider?: Provider;
  config?: FoundConfig;
  pin?: Record<string, string>;
  resolution?: Resolution;
  /** Set on a protected environment: whether the command counts as read-only. */
  readOnly?: boolean;
}

export async function guard(req: GuardRequest, deps: GuardDeps, trace: Trace = {}): Promise<Verdict> {
  const name = commandName(req.bin);
  const provider = deps.providers.find((p) => p.bins.includes(name));
  if (!provider) return { action: "allow", reason: "not-guarded" };
  trace.provider = provider.name;
  // On Windows the provider reads names the way the CLI does, case-insensitively
  // (#119), and so does cloudpin for its own variables, CLOUDPIN_ENV included
  // (#136; envFor keeps an agent from setting those in any spelling).
  const platform = deps.platform ?? process.platform;
  const folded = foldEnvNames(req.env, platform);

  // No folder, so no pin file to apply. With one in sight of the last folder the line knew, by the same search,
  // the call stops: that one, or another where it goes, may pin it. With none, cloudpin does nothing, as anywhere
  // else with no pin file (owner decision, #163). One it can't read counts as in sight, as for any call (#62).
  if (req.cwd === UNKNOWN_FOLDER) {
    if (provider.isExempt(req.args, name)) return { action: "allow", reason: "exempt" };
    if (req.mode === "shell" && folded.env.CLOUDPIN_SKIP === "1") return { action: "allow", reason: "skipped" };
    if (req.knownCwd !== undefined && !pinFileInSight(req.knownCwd, folded.env, deps)) return { action: "allow", reason: "no-config" };
    return { action: "block", uncertain: true, provider: provider.name, problems: [UNKNOWN_CWD.problem], fix: UNKNOWN_CWD.fix };
  }

  let config: FoundConfig | null;
  try {
    config = deps.findConfig(req.cwd, folded.env);
  } catch (err) {
    // A broken pin file must not silently switch protection off. Exempt
    // commands (login, whoami, help, ...) never act on an account, and are
    // what a person needs to investigate, so they still run (#62).
    if (err instanceof ConfigError) {
      if (provider.isExempt(req.args, name)) return { action: "allow", reason: "exempt" };
      return { action: "block", provider: provider.name, problems: [`invalid config: ${err.message}`] };
    }
    throw err;
  }
  if (!config) return { action: "allow", reason: "no-config" };
  trace.config = config;

  const pin = config.pins[provider.name];
  if (!pin) return { action: "allow", reason: "not-pinned" };
  trace.pin = pin as Record<string, string>;
  if (provider.isExempt(req.args, name)) return { action: "allow", reason: "exempt" };
  if (req.mode === "shell" && folded.env.CLOUDPIN_SKIP === "1") return { action: "allow", reason: "skipped" };

  const base = {
    action: "block" as const,
    provider: provider.name,
    configPath: config.path,
    ...(config.environment ? { environment: config.environment } : {}),
  };
  // Track whether the CLI itself is missing: then the command would fail on
  // its own, so there is no account to protect (DESIGN.md, edge cases).
  let cliMissing = false;
  const inner = deps.wrapExec ? deps.wrapExec(provider, folded.env, deps.exec) : deps.exec;
  const exec: Exec = async (bin, args, env) => {
    const result = await inner(bin, args, env);
    if (result.notFound) cliMissing = true;
    return result;
  };
  // What cmd.exe would act on (#168), before resolve, so no CLI is asked with such a value.
  if (req.cmdReread) {
    const { problem, fix } = cmdReread(req.cmdReread);
    return { ...base, uncertain: true, problems: [problem], fix };
  }
  // A variable the line set that can make the CLI run code, before resolve, so no process starts with it.
  const codeVars = req.before ? codeVarsSet(req.before, req.env, platform, name) : [];
  if (codeVars.length > 0) {
    const { problem, fix } = codeVarsStop(codeVars);
    return { ...base, uncertain: true, problems: [problem], fix };
  }
  // An argument only known when it runs (#160), before resolve, so no such value reaches a CLI.
  const dynamic = dynamicTarget(req.args, provider.targetFlags ?? []);
  if (dynamic) return { ...base, uncertain: true, problems: [dynamic.problem], fix: dynamic.fix };
  if (req.envUnknown) return { ...base, uncertain: true, problems: [UNKNOWN_ENV.problem], fix: UNKNOWN_ENV.fix };
  // A variable the line sets from something only known when it runs (#86): if it
  // decides this CLI's account, cloudpin can't tell which account will be used.
  const identityVars = provider.cacheInputs(folded.env, platform).env;
  const unknown = Object.keys(folded.env).filter((k) => folded.env[k] === UNKNOWN_VALUE && envNameMatches(identityVars, k));
  if (unknown.length > 0) {
    return {
      ...base,
      uncertain: true,
      problems: [
        `${unknown.join(", ")} ${unknown.length > 1 ? "are" : "is"} set by the command line from something cloudpin can't read in advance ($(...), backticks, another variable, read or inside a block), so it can't tell which account this command would use`,
      ],
      fix: `set ${unknown[0]} to a literal value, or run the command yourself`,
    };
  }
  const conflict = [...folded.conflicts].find(([k]) => envNameMatches(identityVars, k));
  if (conflict) {
    return {
      ...base,
      uncertain: true,
      problems: [
        `${conflict[1].join(" and ")} are set to different values; on Windows they are one variable, so cloudpin can't tell which value this command would use`,
      ],
      fix: `set ${conflict[0]} in one spelling only`,
    };
  }
  // Other unknown values don't decide the account; the CLI's identity check runs without them.
  const known = Object.fromEntries(Object.entries(folded.env).filter(([, v]) => v !== UNKNOWN_VALUE));
  const before = req.before && foldEnvNames(req.before, platform).env;
  const env = before ? withHooksPath(known, before) : known;
  const res = await provider.resolve({ args: req.args, env, cwd: req.cwd, bin: name, platform }, exec);
  trace.resolution = res;
  if (res.kind === "error" && cliMissing) {
    // Where the line changed PATH the command may find a CLI the lookup can't, so there may be an account to protect.
    if (req.before && lineMovedPath(req.before, req.env, platform)) return { ...base, uncertain: true, problems: [PATH_ONLY_ON_LINE.problem], fix: PATH_ONLY_ON_LINE.fix };
    return { action: "allow", reason: "not-installed" };
  }
  switch (res.kind) {
    case "logged-out":
      return { ...base, problems: ["not logged in"], fix: res.hint };
    case "error":
      // Fail closed: if we cannot tell who the command will act as, we cannot
      // promise it is the right account.
      return { ...base, uncertain: true, problems: [res.message], fix: res.fix ?? provider.statusCommand };
    case "identity": {
      // A pinned field the command's identity can't be read for (#165), e.g. gcloud's account with an access token.
      const unread = Object.entries(res.unknown ?? {}).filter(([field]) => (pin as Record<string, string>)[field]);
      if (unread.length > 0) {
        return { ...base, uncertain: true, problems: unread.map(([, why]) => why), fix: provider.statusCommand };
      }
      // The provider and its pin come from the same key, so the cast is safe.
      const p = provider as ProviderDef<typeof provider.name>;
      const problems = p.compare(pin as never, res.identity);
      if (problems.length > 0) {
        const hint = p.switchHint(pin as never);
        return { ...base, problems, fix: MANUAL_ONLY.has(provider.name) ? hint : `${hint} (or run cloudpin switch)` };
      }
      return protectedEnvironment(req, folded.env, provider.name, config, trace);
    }
  }
}

/** True when `findConfig` finds a pin file from `cwd`, readable or not. */
function pinFileInSight(cwd: string, env: NodeJS.ProcessEnv, deps: GuardDeps): boolean {
  try {
    return deps.findConfig(cwd, env) !== null;
  } catch (err) {
    if (err instanceof ConfigError) return true;
    throw err;
  }
}

/** Providers `cloudpin switch` only explains (#14), so the block message doesn't send people there. */
const MANUAL_ONLY = new Set<Provider>(["supabase", "cloudflare"]);

/**
 * The account is right; on a protected environment a command that may change
 * something still needs the user's yes (issue #12). Only a human can give it
 * ahead of time, with CLOUDPIN_CONFIRM=<environment>. `env` is the command's
 * environment with Windows names folded (#136).
 */
function protectedEnvironment(req: GuardRequest, env: NodeJS.ProcessEnv, provider: Provider, config: FoundConfig, trace: Trace): Verdict {
  const environment = config.environment;
  if (!environment?.protected) return { action: "allow", reason: "match" };
  trace.readOnly = isReadOnly(provider, req.args, env, config.readOnly ?? {}, commandName(req.bin));
  if (trace.readOnly) return { action: "allow", reason: "match" };
  if (req.mode === "shell" && env.CLOUDPIN_CONFIRM === environment.name) {
    return { action: "allow", reason: "confirmed" };
  }
  return { action: "confirm", provider, configPath: config.path, environment };
}

export const defaultFindConfig = findConfig;
