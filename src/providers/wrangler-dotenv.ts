import { readFileSync } from "node:fs";
import { relative, resolve as resolvePath } from "node:path";
import { flagValue } from "../args.js";

// Wrangler loads .env files into its own process.env before every command
// (#116). Sources, github.com/cloudflare/workers-sdk at wrangler@4.151.3:
// packages/wrangler/src/index.ts (createCLIParser: a global check, run after the
// --cwd chdir, loads args["env-file"] ?? getDefaultEnvFiles(args.env), each
// resolved against the working folder) and packages/wrangler/src/config/
// dot-env.ts (loadDotEnv: dotenv 16.3.1 parses each file, later files override
// earlier ones, then dotenv-expand 12.0.2 merges them under process.env, where
// a non-empty variable already set wins and file values have ${VAR} expanded;
// on Windows names are case-insensitive). This behaviour (the four default
// files and --env-file) dates from Wrangler 4.27.0 (workers-sdk PR #9914);
// older versions read .env, or .env.<env> instead of it with --env.
// .dev.vars is separate: Worker bindings for `wrangler dev`, never Wrangler's
// own environment.

/**
 * The variables that decide which account a command uses or which credentials
 * it sends: the account, the --env section, the account cache folder, and every
 * variable cloudflare.cacheInputs keys whoami on (a test keeps them in step).
 */
export const DOTENV_VARS = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_ACCOUNT_ID",
  "CLOUDFLARE_ENV",
  "WRANGLER_CACHE_DIR",
  "CLOUDFLARE_API_TOKEN",
  "CF_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CF_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_EMAIL",
  "CLOUDFLARE_AUTH_USE_KEYRING",
];

/** A line cloudpin can't read exactly as dotenv would; it names the line and key, never the value. */
export class DotenvLineError extends Error {
  constructor(
    readonly line: number,
    readonly key?: string,
  ) {
    super(key === undefined ? "line " + line : "line " + line + " (" + key + ")");
  }
}

const BLANK = /^\s*(#.*)?$/;
const ASSIGNMENT = /^\s*(?:export\s+)?([\w.-]+)\s*=(.*)$/;
const QUOTES = ["'", '"', "`"];

/**
 * Parses the subset of the dotenv 16.3.1 format (lib/main.js, parse and its
 * LINE regex) whose result cloudpin can be sure of: KEY=value lines (with
 * `export`, comments and blank lines), unquoted values cut at #, and values in
 * '', "" or backticks, over several lines if need be, as long as no backslash
 * comes right before the closing quote. Anything else (an escaped quote, text
 * after the closing quote, KEY: value, a line that is not an assignment) throws
 * DotenvLineError, since dotenv's regex might then read lines differently.
 */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (BLANK.test(line)) continue;
    const m = ASSIGNMENT.exec(line);
    if (!m) throw new DotenvLineError(i + 1);
    const key = m[1]!;
    const rest = m[2]!.replace(/^\s+/, "");
    const quote = rest[0];
    if (quote === undefined || !QUOTES.includes(quote)) {
      const hash = rest.indexOf("#");
      out.set(key, (hash === -1 ? rest : rest.slice(0, hash)).trim());
      continue;
    }
    // A quoted value runs to the next quote of the same kind, on this line or a later one.
    const first = i;
    let body = rest.slice(1);
    let value = "";
    let end = body.indexOf(quote);
    while (end === -1) {
      if (++i >= lines.length) throw new DotenvLineError(first + 1, key);
      value += `${body}\n`;
      body = lines[i]!;
      end = body.indexOf(quote);
    }
    value += body.slice(0, end);
    if (value.endsWith("\\") || !BLANK.test(body.slice(end + 1))) throw new DotenvLineError(first + 1, key);
    out.set(key, quote === '"' ? value.replace(/\\n/g, "\n").replace(/\\r/g, "\r") : value);
  }
  return out;
}

/**
 * The files given with --env-file (or --envFile, its camel-case alias), or
 * undefined. yargs-parser 21 arrays are greedy: each word after the flag, up to
 * the next one starting with "-", is another file, also after --env-file=X.
 */
function envFileArgs(args: string[]): string[] | undefined {
  let files: string[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    const name = ["--env-file", "--envFile"].find((n) => arg === n || arg.startsWith(`${n}=`));
    if (name === undefined) continue;
    files ??= [];
    if (arg !== name) files.push(arg.slice(name.length + 1));
    while (i + 1 < args.length && !/^-(?!\d+(\.\d+)?$|\.\d+$)/.test(args[i + 1]!)) files.push(args[++i]!);
  }
  return files;
}

/** Wrangler's getDefaultEnvFiles: .env and .env.local, then .env.<env> and .env.<env>.local with --env. */
function defaultEnvFiles(envName: string | undefined): string[] {
  const files = [".env", ".env.local"];
  if (envName !== undefined) files.push(`.env.${envName}`, `.env.${envName}.local`);
  return files;
}

function readEnvFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    // dotenv's error for a missing file or a folder is skipped by Wrangler.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return undefined;
    throw err;
  }
}

export interface WranglerEnv {
  /** The command's environment plus what the .env files add for DOTENV_VARS; the same object when they add nothing. */
  env: NodeJS.ProcessEnv;
  /** For each variable a file set, that file (relative to the folder). */
  from: Record<string, string>;
}

/**
 * The environment Wrangler would give itself for this command: `env` (the
 * command's own) with the DOTENV_VARS the .env files set, read from `start`
 * (the folder after --cwd; --config doesn't move it). Returns an error, naming
 * the file and variable but never a value, when a file can't be read exactly.
 */
export function wranglerDotenv(
  args: string[],
  env: NodeJS.ProcessEnv,
  start: string,
  platform: NodeJS.Platform = process.platform,
): WranglerEnv | { error: string } {
  const fold = (name: string) => (platform === "win32" ? name.toUpperCase() : name);
  const canonical = new Map(DOTENV_VARS.map((n) => [fold(n), n]));
  const names = envFileArgs(args) ?? defaultEnvFiles(flagValue(args, ["--env", "-e"]));

  // The merged file values, later files winning, keyed by canonical name.
  const merged = new Map<string, { value: string; file: string }>();
  for (const name of names) {
    const path = resolvePath(start, name);
    const file = relative(start, path) || name;
    let parsed: Map<string, string>;
    try {
      const text = readEnvFile(path);
      if (text === undefined) continue;
      parsed = parseDotenv(text);
    } catch (err) {
      if (!(err instanceof DotenvLineError)) return { error: `cloudpin can't read ${file}, which Wrangler loads into its environment` };
      const sets = err.key === undefined ? "" : ` (it sets ${err.key})`;
      return {
        error: `cloudpin can't read line ${err.line} of ${file}${sets} the way Wrangler would, and Wrangler loads that file into its environment: write it as NAME=value, the value unquoted or in plain quotes, or move it out of ${file}`,
      };
    }
    for (const [key, value] of parsed) {
      const name = canonical.get(fold(key));
      if (name !== undefined) merged.set(name, { value, file });
    }
  }
  if (merged.size === 0) return { env, from: {} };

  let out: NodeJS.ProcessEnv | undefined;
  const from: Record<string, string> = {};
  for (const [name, { value, file }] of merged) {
    const keys = Object.keys(env).filter((k) => fold(k) === fold(name));
    const current = keys.length > 0 ? env[keys[keys.length - 1]!] : undefined;
    // dotenv-expand 12.0.2 expand(): a non-empty variable already set wins.
    if (current && current !== value) continue;
    if (value.includes("$")) {
      return {
        error: `${name} in ${file} refers to another variable ($), which cloudpin doesn't expand, so it can't tell the value Wrangler would use: write the value itself in ${file}, or set ${name} in the environment`,
      };
    }
    out ??= { ...env };
    for (const k of keys) delete out[k];
    out[name] = value;
    from[name] = file;
  }
  return { env: out ?? env, from };
}
