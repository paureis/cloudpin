import { parseDocument, type YAMLMap } from "yaml";
import { ConfigError, isEnvironmentName, parseConfig, type Provider } from "./config.js";
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
  vercel: { fields: ["team"], comment: "label" },
  github: { fields: ["user", "host"] },
};

const DEFAULT_GITHUB_HOST = "github.com";

const HEADER = [
  "# cloudpin: the cloud accounts this project uses. Commit this file.",
  "# Docs: https://github.com/paureis/cloudpin",
];

/** One section per provider. Values are double-quoted (JSON is valid YAML). */
function providerLines(found: FoundIdentity[]): string[] {
  const lines: string[] = [];
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
  return lines;
}

/** Renders .cloudpin.yml in the flat format. */
export function renderConfig(found: FoundIdentity[]): string {
  return `${[...HEADER, ...providerLines(found)].join("\n")}\n`;
}

/**
 * Adds (or with `force`, replaces) one environment in a .cloudpin.yml, or
 * starts a new file with it. The `yaml` document API keeps the rest of an
 * existing file as written, comments included. Throws ConfigError.
 */
export function addEnvironment(
  existing: string | null,
  name: string,
  isProtected: boolean,
  found: FoundIdentity[],
  force: boolean,
): string {
  if (!isEnvironmentName(name)) {
    throw new ConfigError(`invalid environment name "${name}" (use letters, digits, "-", "_" or ".")`);
  }
  const block = [`${name}:`, ...(isProtected ? ["  protected: true"] : []), ...providerLines(found).map((l) => `  ${l}`)];
  const project = existing === null ? null : parseConfig(existing);
  let text: string;
  if (project === null || (project.environments === null && Object.keys(project.pins).length === 0)) {
    const intro = existing?.trim() ? [existing.trimEnd()] : HEADER;
    text = `${[...intro, "environments:", ...block.map((l) => `  ${l}`)].join("\n")}\n`;
  } else if (project.environments === null) {
    throw new ConfigError(
      "this file uses the flat format; to add environments, move its provider sections under " +
        '"environments:" and a name (see Environments in the README), then run this again',
    );
  } else {
    if (project.environments.some((e) => e.name === name) && !force) {
      throw new ConfigError(`environment "${name}" already exists (use --force to replace it)`);
    }
    const doc = parseDocument(existing!, { schema: "failsafe" });
    const pair = (parseDocument(`${block.join("\n")}\n`, { schema: "failsafe" }).contents as YAMLMap).items[0]!;
    (doc.get("environments", true) as YAMLMap).set(pair.key, pair.value);
    text = doc.toString();
  }
  parseConfig(text); // Never write a file cloudpin itself would reject.
  return text;
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
