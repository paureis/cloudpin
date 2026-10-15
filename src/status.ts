import type { ActiveEnvironment, FoundConfig } from "./config.js";
import { type GuardDeps, installed } from "./guard.js";
import type { Exec, Identity } from "./types.js";

export type ProviderStatus =
  | { name: string; state: "not-installed" }
  | { name: string; state: "logged-out"; hint: string }
  | { name: string; state: "error"; message: string }
  /** Nothing in this folder names a project or account for it (see Resolution). */
  | { name: string; state: "no-target"; message: string }
  | {
      name: string;
      state: "active";
      identity: Identity;
      pin?: Record<string, string>;
      match?: boolean;
      problems?: string[];
    };

export interface Status {
  pinFile: string | null;
  configError?: string;
  /** Set when the pin file defines environments. */
  environment?: ActiveEnvironment;
  providers: ProviderStatus[];
  hooks: string[];
}

/**
 * A read-only overview: each CLI's active account, what the nearest pin file
 * says about it, and which agent hooks are installed. `hooks` lists installed
 * hooks (injected so tests don't read real settings files).
 */
export async function collectStatus(
  deps: GuardDeps,
  cwd: string,
  env: NodeJS.ProcessEnv,
  hooks: () => string[],
): Promise<Status> {
  let config: FoundConfig | null = null;
  let configError: string | undefined;
  try {
    config = deps.findConfig(cwd, env);
  } catch (err) {
    configError = (err as Error).message;
  }
  const providers: ProviderStatus[] = [];
  for (const provider of deps.providers) {
    if (!installed(provider, env, deps.onPath)) {
      providers.push({ name: provider.name, state: "not-installed" });
      continue;
    }
    let missing = false;
    const base = deps.wrapExec ? deps.wrapExec(provider, env, deps.exec) : deps.exec;
    const exec: Exec = async (bin, args, e) => {
      const r = await base(bin, args, e);
      if (r.notFound) missing = true;
      return r;
    };
    const res = await provider.resolve({ args: [], env, cwd }, exec);
    const name = provider.name;
    if (missing) providers.push({ name, state: "not-installed" });
    else if (res.kind === "logged-out") providers.push({ name, state: "logged-out", hint: res.hint });
    else if (res.kind === "error") providers.push({ name, state: res.noTarget ? "no-target" : "error", message: res.message });
    else {
      const pin = config?.pins[name] as Record<string, string> | undefined;
      if (!pin) {
        providers.push({ name, state: "active", identity: res.identity });
        continue;
      }
      const problems = provider.compare(pin as never, res.identity);
      providers.push({ name, state: "active", identity: res.identity, pin, match: problems.length === 0, problems });
    }
  }
  return {
    pinFile: config?.path ?? null,
    ...(configError ? { configError } : {}),
    ...(config?.environment ? { environment: config.environment } : {}),
    providers,
    hooks: hooks(),
  };
}

// Identity fields shown in brackets after the main value, as context.
const CONTEXT_FIELDS = new Set(["name", "arn", "label", "host", "context"]);

/** An identity as one line: the IDs, then names and other context in brackets. */
export function describe(identity: Identity): string {
  const main = Object.entries(identity)
    .filter(([k, v]) => !CONTEXT_FIELDS.has(k) && v)
    .map(([, v]) => v);
  const context = Object.entries(identity)
    .filter(([k, v]) => CONTEXT_FIELDS.has(k) && v)
    .map(([, v]) => v);
  return `${main.join(" / ")}${context.length ? ` (${context.join(", ")})` : ""}`;
}

/** The status as human-readable lines. */
export async function buildStatus(
  deps: GuardDeps,
  cwd: string,
  env: NodeJS.ProcessEnv,
  hooks: () => string[],
): Promise<string[]> {
  const status = await collectStatus(deps, cwd, env, hooks);
  const lines = [
    status.configError
      ? `Pin file: invalid (${status.configError})`
      : `Pin file: ${status.pinFile ?? "none here or in any parent folder"}`,
  ];
  if (status.environment) {
    const { name, source } = status.environment;
    const kind = status.environment.protected ? " (protected: changing commands ask first)" : "";
    lines.push(`Environment: ${name}${kind}, chosen by ${source}`);
  }
  lines.push("");
  const width = Math.max(...status.providers.map((p) => p.name.length));
  for (const p of status.providers) {
    const label = `  ${p.name.padEnd(width)}  `;
    const pad = " ".repeat(label.length);
    if (p.state === "not-installed") lines.push(`${label}not installed`);
    else if (p.state === "logged-out") lines.push(`${label}not logged in (${p.hint})`);
    else if (p.state === "error") lines.push(`${label}could not tell: ${p.message}`);
    else if (p.state === "no-target") lines.push(`${label}nothing in this folder says which one (${p.message})`);
    else {
      lines.push(`${label}active: ${describe(p.identity)}`);
      if (!p.pin) lines.push(`${pad}not pinned here`);
      else {
        const verdict = p.match ? "ok" : `MISMATCH: ${(p.problems ?? []).join("; ")}`;
        lines.push(`${pad}pinned: ${Object.values(p.pin).join(" / ")}  ->  ${verdict}`);
      }
    }
  }
  lines.push("", `Agent hooks: ${status.hooks.length ? status.hooks.join(", ") : "none installed"}`);
  return lines;
}
