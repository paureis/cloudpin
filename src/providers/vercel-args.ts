// How the Vercel CLI parses its arguments, read by vercel.ts (#147 moved this here).

// Global options (vercel/vercel packages/cli/src/util/arg-common.ts globalCommandOptions; 50.35).
const GLOBAL_BOOLEAN_FLAGS: Readonly<Record<string, string>> = {
  "--help": "--help", "-h": "--help", "--version": "--version", "-v": "--version",
  "--debug": "--debug", "-d": "--debug", "--no-color": "--no-color", "--non-interactive": "--non-interactive",
};
const GLOBAL_VALUE_FLAGS = new Set([
  "--cwd", "--global-config", "-Q", "--local-config", "-A", "--scope", "-S", "--team", "-T", "--token", "-t", "--api",
]);
// Built-in commands and aliases (src/commands/index.ts; 50.35) that print their help and stop
// on --help or -h. Left out because they can run anyway: `promote <id>` and `rollback <id>`
// show help only without a deployment, and `rolling-release`/`rr` look for a literal --help or
// -h word, so `-dh` runs them. Any other word may be an extension (vercel-<word>), which Vercel
// runs without the --help it parsed itself (src/util/extension/exec.ts).
export const HELP_COMMANDS = new Set([
  "activity", "agent", "alerts", "alias", "aliases", "ln", "api", "bisect", "blob", "build", "buy", "cache",
  "certs", "cert", "contract", "crons", "cron", "curl", "deploy", "dev", "develop", "dns", "domains", "domain",
  "env", "flags", "git", "httpstat", "init", "inspect", "install", "i", "integration", "integration-resource",
  "ir", "link", "list", "ls", "logs", "log", "mcp", "microfrontends", "mf", "open", "project", "projects",
  "pull", "redeploy", "redirects", "redirect", "remove", "rm", "routes", "skills", "target", "targets", "teams",
  "team", "upgrade", "usage", "webhooks", "webhook",
]);

/** The options a parse knows: the globals, plus a command's own (getFlagsSpecification). */
interface Spec {
  booleans: ReadonlySet<string>;
  values: ReadonlySet<string>;
}
const GLOBALS: Spec = { booleans: new Set(Object.keys(GLOBAL_BOOLEAN_FLAGS)), values: GLOBAL_VALUE_FLAGS };

interface MainParse {
  /** Positionals, with the flags the spec doesn't know when permissive; the first is the command. */
  positionals: string[];
  /** The boolean flags seen; the global ones by long name. */
  flags: Set<string>;
}

/**
 * The arguments as Vercel's main() parses them (packages/cli/src/index.ts, src/util/get-args.ts):
 * arg 5.0.0 with the global options and `{ permissive: true }`. A flag it doesn't know, or an
 * unknown letter of a short group, is kept as a positional and the rest of the group is still
 * read, so `-dy whoami` has the command `-y`: no command and no extension has that name, so
 * Vercel deploys. Every word after "--" is a positional. Undefined when arg would throw (a value
 * flag not last in its group, or without a value), which stops Vercel before any command runs.
 */
export const mainParse = (args: string[]) => argParse(args, GLOBALS, true);

/**
 * The arguments as arg 5.0.0 parses them with `spec` (src/util/get-args.ts parseArguments).
 * Not permissive, as commands parse, an unknown flag is an error: undefined.
 */
function argParse(args: string[], spec: Spec, permissive: boolean): MainParse | undefined {
  const positionals: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (word.length < 2 || word[0] !== "-") {
      positionals.push(word);
      continue;
    }
    const parts = word[1] === "-" || word.length === 2 ? [word] : word.slice(1).split("").map((c) => `-${c}`);
    for (let j = 0; j < parts.length; j++) {
      const part = parts[j]!;
      const eq = part.startsWith("--") ? part.indexOf("=") : -1;
      const name = eq === -1 ? part : part.slice(0, eq);
      if (spec.booleans.has(name)) {
        flags.add(GLOBAL_BOOLEAN_FLAGS[name] ?? name);
      } else if (!spec.values.has(name)) {
        if (!permissive) return undefined;
        positionals.push(part);
      } else if (eq === -1) {
        const value = args[i + 1];
        if (j < parts.length - 1 || value === undefined || (value.length > 1 && value[0] === "-")) return undefined;
        i++;
      }
    }
  }
  return { positionals, flags };
}

/**
 * The arguments as Vercel's parser sees them, so a short group's flags and value are read
 * (#125). Vercel parses with arg 5.0.0 (vercel/vercel packages/cli/package.json;
 * github.com/vercel/arg index.js, tag 5.0.0), which splits a single-dash word longer than two
 * characters into one flag per letter (`-dT` is `-d -T`); a last letter that takes a value
 * reads the next word, and a value letter anywhere else is an error. A value never starts
 * with "-", so splitting every such word before "--" is exact.
 */
export function splitShortGroups(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return [...out, ...args.slice(i)];
    if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") out.push(...arg.slice(1).split("").map((c) => `-${c}`));
    else out.push(arg);
  }
  return out;
}
