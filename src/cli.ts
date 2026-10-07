#!/usr/bin/env node
import spawn from "cross-spawn";
import { createRequire } from "node:module";
import { ConfigError, findConfig, PROVIDERS } from "./config.js";
import { realExec } from "./exec.js";
import { formatBlock } from "./format.js";
import { guard, type GuardDeps } from "./guard.js";
import { providers } from "./providers/index.js";

/** Exit code for a blocked command, distinct from the usual 1 and 2. */
export const EXIT_BLOCKED = 3;

const USAGE = `cloudpin: a seatbelt for your cloud CLIs

Usage:
  cloudpin check              Check every CLI pinned in the nearest .cloudpin.yml
  cloudpin exec -- <cmd...>   Run <cmd> only if it would act on the pinned account
  cloudpin --version

Exit codes: 0 ok, 1 usage or check failure, ${EXIT_BLOCKED} command blocked.`;

const deps: GuardDeps = { providers, exec: realExec, findConfig };

async function check(): Promise<number> {
  let config;
  try {
    config = findConfig(process.cwd());
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`cloudpin: invalid config: ${err.message}`);
      return 1;
    }
    throw err;
  }
  if (!config) {
    console.log("cloudpin: no .cloudpin.yml found here or in any parent folder; nothing is pinned.");
    return 0;
  }
  console.log(`cloudpin: checking ${config.path}`);
  let ok = true;
  for (const name of PROVIDERS) {
    if (!config.pins[name]) continue;
    const provider = providers.find((p) => p.name === name);
    if (!provider) {
      console.log(`  ? ${name}: pinned, but not supported by this version of cloudpin yet`);
      ok = false;
      continue;
    }
    // "agent" mode so CLOUDPIN_SKIP cannot make a check report success.
    const verdict = await guard(
      { bin: provider.bins[0]!, args: [], env: process.env, cwd: process.cwd(), mode: "agent" },
      deps,
    );
    if (verdict.action === "allow") {
      console.log(`  ok ${name}: active account matches the pin`);
    } else {
      ok = false;
      console.log(`  x  ${name}`);
      for (const problem of verdict.problems) console.log(`     - ${problem}`);
      if (verdict.fix) console.log(`     fix: ${verdict.fix}`);
    }
  }
  return ok ? 0 : 1;
}

async function exec(argv: string[]): Promise<number> {
  const [bin, ...args] = argv;
  if (!bin) {
    console.error("cloudpin exec: missing command after --");
    return 1;
  }
  const verdict = await guard({ bin, args, env: process.env, cwd: process.cwd(), mode: "shell" }, deps);
  if (verdict.action === "block") {
    console.error(formatBlock(verdict, argv, "shell"));
    return EXIT_BLOCKED;
  }
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: "inherit" });
    child.on("error", (err) => {
      console.error(`cloudpin exec: ${err.message}`);
      resolve(127);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "check":
      return check();
    case "exec":
      return exec(rest[0] === "--" ? rest.slice(1) : rest);
    case "--version":
    case "-v": {
      const pkg = createRequire(import.meta.url)("../package.json") as { version: string };
      console.log(pkg.version);
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      console.error(`cloudpin: unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
