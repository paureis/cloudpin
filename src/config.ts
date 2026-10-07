import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, YAMLParseError } from "yaml";

export const CONFIG_FILE = ".cloudpin.yml";

export interface Pins {
  azure?: { subscription: string; tenant?: string };
  aws?: { account: string };
  gcloud?: { account?: string; project?: string };
  vercel?: { team: string };
  github?: { user: string; host?: string };
}

export type Provider = keyof Pins;

export class ConfigError extends Error {
  override name = "ConfigError";
}

// Allowed keys per section; the first `required` entries must be present.
const SCHEMA: Record<Provider, { keys: string[]; required: string[] }> = {
  azure: { keys: ["subscription", "tenant"], required: ["subscription"] },
  aws: { keys: ["account"], required: ["account"] },
  gcloud: { keys: ["account", "project"], required: [] },
  vercel: { keys: ["team"], required: ["team"] },
  github: { keys: ["user", "host"], required: ["user"] },
};

export const PROVIDERS = Object.keys(SCHEMA) as Provider[];

function isProvider(name: string): name is Provider {
  return Object.hasOwn(SCHEMA, name);
}

export function parseConfig(text: string): Pins {
  let doc: unknown;
  try {
    // The failsafe schema reads every scalar as a string, so an unquoted AWS
    // account ID such as 012345678901 keeps its leading zero.
    doc = parse(text, { schema: "failsafe" });
  } catch (err) {
    if (err instanceof YAMLParseError) throw new ConfigError(err.message);
    throw err;
  }
  if (doc === null || doc === undefined || doc === "") return {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new ConfigError("expected a mapping of provider sections");
  }

  const pins: Record<string, Record<string, string>> = {};
  for (const [section, body] of Object.entries(doc)) {
    if (!isProvider(section)) {
      throw new ConfigError(
        `unknown section "${section}" (expected one of: ${PROVIDERS.join(", ")})`,
      );
    }
    const { keys, required } = SCHEMA[section];
    const fields: Record<string, string> = {};
    if (body !== "" && body !== null) {
      if (typeof body !== "object" || Array.isArray(body)) {
        throw new ConfigError(`${section}: expected a mapping of keys`);
      }
      for (const [key, value] of Object.entries(body)) {
        if (!keys.includes(key)) {
          throw new ConfigError(
            `${section}: unknown key "${key}" (expected: ${keys.join(", ")})`,
          );
        }
        if (typeof value !== "string" || value.trim() === "") {
          throw new ConfigError(`${section}: "${key}" must be a non-empty value`);
        }
        fields[key] = value.trim();
      }
    }
    for (const key of required) {
      if (!(key in fields)) throw new ConfigError(`${section}: "${key}" is required`);
    }
    if (section === "gcloud" && Object.keys(fields).length === 0) {
      throw new ConfigError('gcloud: set "account", "project" or both');
    }
    pins[section] = fields;
  }
  return pins as Pins;
}

export interface FoundConfig {
  path: string;
  pins: Pins;
}

/** Finds the nearest .cloudpin.yml at or above `startDir`. */
export function findConfig(startDir: string): FoundConfig | null {
  let dir = startDir;
  for (;;) {
    const path = join(dir, CONFIG_FILE);
    if (existsSync(path)) {
      try {
        return { path, pins: parseConfig(readFileSync(path, "utf8")) };
      } catch (err) {
        if (err instanceof ConfigError) {
          throw new ConfigError(`${path}: ${err.message}`);
        }
        throw err;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
