#!/usr/bin/env node
import spawn from "cross-spawn";
import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { cachedExec } from "./cache.js";
import { CONFIG_FILE, ConfigError, findConfig, PROVIDERS } from "./config.js";
import { realExec } from "./exec.js";
import { formatBlock } from "./format.js";
import { guard, type GuardDeps } from "./guard.js";
import { claudeHook } from "./hooks/claude.js";
import { discover, renderConfig } from "./init.js";
import { cacheDir } from "./paths.js";
import { shellInit } from "./shell-init.js";
import { providers } from "./providers/index.js";

/** Exit code for a blocked command, distinct from the usual 1 and 2. */
export const EXIT_BLOCKED = 3;

const USAGE = `cloudpin: a seatbelt for your cloud CLIs

Usage:
  cloudpin init [--yes] [--force]
                              Pin the accounts you are logged into now, in ./.cloudpin.yml
  cloudpin check              Check every CLI pinned in the nearest .cloudpin.yml
  cloudpin exec -- <cmd...>   Run <cmd> only if it would act on the pinned account
  cloudpin hook claude        Claude Code PreToolUse hook (reads the hook JSON on stdin)
  cloudpin shell-init <bash|zsh|pwsh>
                              Print shell functions that guard az, aws, gcloud, vercel and gh
  cloudpin --version

Exit codes: 0 ok, 1 usage or check failure, ${EXIT_BLOCKED} command blocked.`;

// `check` always asks the CLIs directly; `exec` and the hooks use the short-lived
// identity cache (src/cache.ts), which CLOUDPIN_NO_CACHE=1 turns off.
const deps: GuardDeps = { providers, exec: realExec, findConfig };
const cachedDeps: GuardDeps = {
  ...deps,
  wrapExec: (provider, env, exec) =>
    cachedExec(exec, provider.cacheInputs(env), { cacheDir: cacheDir(), env: process.env }),
};

async function init(flags: string[]): Promise<number> {
  const path = join(process.cwd(), CONFIG_FILE);
  if (existsSync(path) && !flags.includes("--force")) {
    console.error(`cloudpin init: ${path} already exists (use --force to replace it)`);
    return 1;
  }
  console.log("cloudpin: reading the accounts your CLIs are logged into...");
  const { found, skipped } = await discover(providers, realExec, process.env, process.cwd());
  for (const line of skipped) console.log(`  skipped ${line}`);
  if (found.length === 0) {
    console.error("cloudpin init: no logged-in CLI found; log in to the accounts this project uses first.");
    return 1;
  }
  const text = renderConfig(found);
  console.log(`\nProposed ${CONFIG_FILE}:\n\n${text}`);
  if (!flags.includes("--yes")) {
    if (!process.stdin.isTTY) {
      console.error("cloudpin init: not a terminal; re-run with --yes to write the file.");
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Pin these accounts to this project? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("cloudpin init: nothing written.");
      return 1;
    }
  }
  writeFileSync(path, text);
  console.log(`cloudpin: wrote ${path}. Commit it so everyone on the project is protected.`);
  return 0;
}

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
    if (verdict.action === "allow" && verdict.reason === "not-installed") {
      console.log(`  -  ${name}: ${provider.bins[0]} is not installed here, nothing to check`);
    } else if (verdict.action === "allow") {
      console.log(`  ok ${name}: active account matches the pin`);
    } else {
      ok = false;
      if (verdict.uncertain) {
        console.log(`  x  ${name}: could not tell which account is active, so commands will be stopped`);
        for (const problem of verdict.problems) console.log(`     - reason: ${problem}`);
        if (verdict.fix) console.log(`     to see what is wrong: ${verdict.fix}`);
      } else {
        console.log(`  x  ${name}`);
        for (const problem of verdict.problems) console.log(`     - ${problem}`);
        if (verdict.fix) console.log(`     fix: ${verdict.fix}`);
      }
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
  const verdict = await guard({ bin, args, env: process.env, cwd: process.cwd(), mode: "shell" }, cachedDeps);
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

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += String(chunk);
  return data;
}

async function hook(agent: string | undefined): Promise<number> {
  if (agent !== "claude") {
    console.error(`cloudpin hook: unsupported agent "${agent ?? ""}" (supported: claude)`);
    return 1;
  }
  const out = await claudeHook(await readStdin(), cachedDeps, process.env);
  if (out) process.stdout.write(`${out}\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return init(rest);
    case "check":
      return check();
    case "exec":
      return exec(rest[0] === "--" ? rest.slice(1) : rest);
    case "hook":
      return hook(rest[0]);
    case "shell-init":
      try {
        process.stdout.write(shellInit(rest[0] ?? "", providers.flatMap((p) => p.bins)));
        return 0;
      } catch (err) {
        console.error(`cloudpin shell-init: ${(err as Error).message}`);
        return 1;
      }
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
