import type { FoundConfig } from "./config.js";
import type { GuardDeps } from "./guard.js";
import type { Exec, Identity } from "./types.js";

// Identity fields shown in brackets after the main value, as context.
const CONTEXT_FIELDS = new Set(["name", "arn", "label", "host"]);

function describe(identity: Identity): string {
  const main = Object.entries(identity)
    .filter(([k, v]) => !CONTEXT_FIELDS.has(k) && v)
    .map(([, v]) => v);
  const context = Object.entries(identity)
    .filter(([k, v]) => CONTEXT_FIELDS.has(k) && v)
    .map(([, v]) => v);
  return `${main.join(" / ")}${context.length ? ` (${context.join(", ")})` : ""}`;
}

/**
 * A read-only overview: each CLI's active account, what the nearest pin file
 * says about it, and which agent hooks are installed. `hooks` lists installed
 * hooks (injected so tests don't read real settings files).
 */
export async function buildStatus(
  deps: GuardDeps,
  cwd: string,
  env: NodeJS.ProcessEnv,
  hooks: () => string[],
): Promise<string[]> {
  let config: FoundConfig | null = null;
  let configError: string | undefined;
  try {
    config = deps.findConfig(cwd);
  } catch (err) {
    configError = (err as Error).message;
  }
  const lines = [
    configError ? `Pin file: invalid (${configError})` : `Pin file: ${config ? config.path : "none here or in any parent folder"}`,
    "",
  ];
  const width = Math.max(...deps.providers.map((p) => p.name.length));
  for (const provider of deps.providers) {
    const label = `  ${provider.name.padEnd(width)}  `;
    const pad = " ".repeat(label.length);
    let missing = false;
    const base = deps.wrapExec ? deps.wrapExec(provider, env, deps.exec) : deps.exec;
    const exec: Exec = async (bin, args, e) => {
      const r = await base(bin, args, e);
      if (r.notFound) missing = true;
      return r;
    };
    const res = await provider.resolve({ args: [], env, cwd }, exec);
    if (missing) {
      lines.push(`${label}not installed`);
      continue;
    }
    if (res.kind === "logged-out") {
      lines.push(`${label}not logged in (${res.hint})`);
      continue;
    }
    if (res.kind === "error") {
      lines.push(`${label}could not tell: ${res.message}`);
      continue;
    }
    lines.push(`${label}active: ${describe(res.identity)}`);
    const pin = config?.pins[provider.name];
    if (!pin) {
      lines.push(`${pad}not pinned here`);
      continue;
    }
    const problems = provider.compare(pin as never, res.identity);
    const pinned = Object.values(pin as Record<string, string>).join(" / ");
    lines.push(`${pad}pinned: ${pinned}  ->  ${problems.length ? `MISMATCH: ${problems.join("; ")}` : "ok"}`);
  }
  const installed = hooks();
  lines.push("", `Agent hooks: ${installed.length ? installed.join(", ") : "none installed"}`);
  return lines;
}
