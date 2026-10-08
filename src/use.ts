import { readFileSync } from "node:fs";
import { ConfigError, locateConfig, parseConfig, selectEnvironment } from "./config.js";
import { chooseEnvironment, currentBranch, findGitDir } from "./git.js";

export interface UseResult {
  code: number;
  lines: string[];
}

/**
 * `cloudpin use [<env> | --clear]`: shows the environments, or remembers
 * (forgets) the one to use in this clone. The choice lives in the git folder,
 * so it is never committed. Reads the file without applying the current
 * choice, so a choice that names a removed environment can still be replaced.
 */
export function useCommand(args: string[], cwd: string, env: NodeJS.ProcessEnv): UseResult {
  const fail = (line: string): UseResult => ({ code: 1, lines: [line] });
  const path = locateConfig(cwd);
  if (!path) return fail("cloudpin use: no .cloudpin.yml here or in any parent folder");
  let project;
  try {
    project = parseConfig(readFileSync(path, "utf8"));
  } catch (err) {
    if (err instanceof ConfigError) return fail(`cloudpin use: invalid config: ${path}: ${err.message}`);
    throw err;
  }
  const envs = project.environments;
  if (!envs) return fail(`cloudpin use: ${path} defines no environments (see "environments" in the README)`);
  const gitDir = findGitDir(cwd);
  const [name] = args;

  if (name === undefined) {
    let active;
    try {
      active = selectEnvironment(project, {
        env,
        chosen: gitDir ? chooseEnvironment(gitDir) : null,
        branch: gitDir ? currentBranch(gitDir) : null,
      });
    } catch (err) {
      if (err instanceof ConfigError) return fail(`cloudpin use: ${err.message}; run cloudpin use <name> or --clear`);
      throw err;
    }
    return {
      code: 0,
      lines: [
        `cloudpin: environments in ${path}`,
        ...envs.map((e) => {
          const label = `${e.name}${e.protected ? " (protected)" : ""}`;
          return e.name === active?.name ? `  * ${label}  <- chosen by ${active.source}` : `    ${label}`;
        }),
        "Choose one here with: cloudpin use <name>   (forget it with: cloudpin use --clear)",
      ],
    };
  }

  if (!gitDir) {
    return fail(
      `cloudpin use: not in a git repository, so there is nowhere private to remember it; set CLOUDPIN_ENV=${name} instead`,
    );
  }
  if (name === "--clear") {
    chooseEnvironment(gitDir, null);
    return { code: 0, lines: ["cloudpin: forgot the chosen environment; the branch mapping or the first one applies"] };
  }
  if (!envs.some((e) => e.name === name)) {
    return fail(`cloudpin use: no environment "${name}" (defined: ${envs.map((e) => e.name).join(", ")})`);
  }
  chooseEnvironment(gitDir, name);
  const lines = [`cloudpin: using ${name} here (remembered for this clone, not committed)`];
  if (env.CLOUDPIN_ENV && env.CLOUDPIN_ENV !== name) {
    lines.push(`  note: CLOUDPIN_ENV=${env.CLOUDPIN_ENV} is set in this shell and takes precedence`);
  }
  return { code: 0, lines };
}
