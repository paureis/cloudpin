import type { Provider } from "./config.js";
import type { Exec, Identity, ProviderDef } from "./types.js";

export interface FoundIdentity {
  provider: Provider;
  identity: Identity;
}

// Which identity fields become pins, and which one is a human-readable comment.
const PIN_FIELDS: Record<Provider, { fields: string[]; comment?: string }> = {
  azure: { fields: ["subscription", "tenant"], comment: "name" },
  aws: { fields: ["account"], comment: "arn" },
  gcloud: { fields: ["account", "project"] },
  vercel: { fields: ["team"] },
  github: { fields: ["user", "host"] },
};

const DEFAULT_GITHUB_HOST = "github.com";

/** Renders .cloudpin.yml. Values are double-quoted (JSON is valid YAML). */
export function renderConfig(found: FoundIdentity[]): string {
  const lines = [
    "# cloudpin: the cloud accounts this project uses. Commit this file.",
    "# Docs: https://github.com/paureis/cloudpin",
  ];
  for (const { provider, identity } of found) {
    const { fields, comment } = PIN_FIELDS[provider];
    lines.push(`${provider}:`);
    let first = true;
    for (const field of fields) {
      const value = identity[field];
      if (!value) continue;
      if (provider === "github" && field === "host" && value === DEFAULT_GITHUB_HOST) continue;
      const note = first && comment && identity[comment] ? ` # ${identity[comment]!.replace(/\s+/g, " ")}` : "";
      lines.push(`  ${field}: ${JSON.stringify(value)}${note}`);
      first = false;
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface Discovery {
  found: FoundIdentity[];
  /** One line per provider that could not be read, e.g. "aws: not logged in". */
  skipped: string[];
}

/** Reads the active account of every supported CLI that is installed. */
export async function discover(
  providers: ProviderDef[],
  exec: Exec,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<Discovery> {
  const found: FoundIdentity[] = [];
  const skipped: string[] = [];
  for (const provider of providers) {
    const res = await provider.resolve({ args: [], env, cwd }, exec);
    if (res.kind === "identity") found.push({ provider: provider.name, identity: res.identity });
    else if (res.kind === "logged-out") skipped.push(`${provider.name}: not logged in (${res.hint})`);
    else skipped.push(`${provider.name}: ${res.message}`);
  }
  return { found, skipped };
}
