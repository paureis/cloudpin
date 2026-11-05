/**
 * Variables that can make a program run code it is pointed at. To check a call cloudpin starts the CLI's identity
 * lookup with the call's own environment (rules 3 and 5 of provider code), so one of these set on the line would run
 * what the line chose, before any verdict. One set before the agent started is the user's choice and stays
 * (THREAT_MODEL.md, "Environment set up by someone else"), so only what the line changed counts.
 *
 * Each was run through the hook with a printer where one can show it, on Windows: NODE_OPTIONS (--import=data: and
 * --require), NODE_PATH, PYTHONPATH, PYTHONHOME, PYTHONUSERBASE, APPDATA (the user site, a .pth file), PYTHONPYCACHEPREFIX,
 * PYTHONINSPECT with PYTHONSTARTUP (stdin is the null device, which Windows calls a terminal), CLOUDSDK_PYTHON and
 * CLOUDSDK_PYTHON_ARGS, BASH_ENV, SHELLOPTS with PS4, BASH_FUNC_ names. `python -I`, as the real az.cmd of the MSI runs it,
 * ignores every PYTHON* name, but a pip or Homebrew az and aws v1 don't. The rest are from their documentation, as no
 * real CLI may run here: the python, node and bash manuals; ld.so(8) and dyld(1); AWS's credential_process, which runs
 * from AWS_CONFIG_FILE or (botocore session.full_config) the credentials file, under HOME or USERPROFILE by default;
 * az's extension folder (azure-cli-core extension/__init__.py); COMSPEC, the shell Node's exec and Python's
 * shell=True start. The Perl and Ruby names are for a wrapper script around a CLI: none of the CLIs is one.
 *
 * Not here, because a lookup never reaches them: PYTHONBREAKPOINT (only breakpoint() reads it), ENV (interactive shells),
 * PAGER and friends (a pager needs a terminal, and a lookup's output is a pipe), helm's and kubectl's plugin and
 * exec-credential settings (kubernetes.ts reads the kubeconfig and starts nothing).
 */
const RUNS_CODE = new Set([
  "NODE_OPTIONS", "NODE_PATH",
  "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONUSERBASE", "PYTHONPYCACHEPREFIX", "PYTHONPLATLIBDIR", "PYTHONWARNINGS",
  "CLOUDSDK_PYTHON", "CLOUDSDK_PYTHON_ARGS",
  "AZURE_EXTENSION_DIR", "AZURE_EXTENSION_SYS_DIR", "AZURE_EXTENSION_DEV_SOURCES",
  "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA",
  "BASH_ENV", "SHELLOPTS", "PS4", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "COMSPEC",
  "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB",
]);
const RUNS_CODE_PREFIX = /^(DYLD_|BASH_FUNC_)/;

/** Each name of `before` with every value it holds: on Windows a name has several spellings, each with its own. */
function valuesByName(before: NodeJS.ProcessEnv, platform: NodeJS.Platform): Map<string, Set<string | undefined>> {
  const had = new Map<string, Set<string | undefined>>();
  for (const [key, value] of Object.entries(before)) {
    const name = platform === "win32" ? key.toUpperCase() : key;
    had.set(name, (had.get(name) ?? new Set()).add(value));
  }
  return had;
}

/** What the line changed from `before`: the names as a program reads them, Windows folding case (#119). */
function setOnLine(before: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, counts: (name: string) => boolean): string[] {
  const had = valuesByName(before, platform);
  const names = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    const name = platform === "win32" ? key.toUpperCase() : key;
    if (value !== undefined && counts(name) && !had.get(name)?.has(value)) names.add(name);
  }
  return [...names].sort();
}

/** The variables the line set, from `before` to `env`, that can make the CLI run code. */
export function codeVarsSet(before: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  return setOnLine(before, env, platform, (name) => RUNS_CODE.has(name) || RUNS_CODE_PREFIX.test(name));
}

/**
 * PATH and PATHEXT choose the file that starts and, in a shim, what it starts by bare name (npm's cmd-shim runs `node`).
 * Agents set PATH for honest reasons, so they don't stop a call: the lookup uses the ones the line started with. The
 * identity can only differ if the line's PATH leads to another program named like the CLI, which THREAT_MODEL.md leaves
 * out ("A compromised machine or PATH"); another install of the CLI reads the same account files.
 */
const FROM_THE_HOOK = ["PATH", "PATHEXT"];

/** `env`, folded as guard reads it, with the PATH and PATHEXT of `before`, folded the same way. */
export function withHooksPath(env: NodeJS.ProcessEnv, before: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of FROM_THE_HOOK) {
    if (before[name] === undefined) delete out[name];
    else out[name] = before[name];
  }
  return out;
}

/** Whether the line changed PATH or PATHEXT, in any spelling, removing it included. */
export function lineMovedPath(before: NodeJS.ProcessEnv, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (setOnLine(before, env, platform, (name) => FROM_THE_HOOK.includes(name)).length > 0) return true;
  const kept = valuesByName(env, platform);
  return [...valuesByName(before, platform).keys()].some((name) => FROM_THE_HOOK.includes(name) && !kept.has(name));
}

/** Why a call stops when its CLI isn't on the hook's PATH and the line changed it. */
export const PATH_ONLY_ON_LINE = {
  problem: "the command line changes PATH, and cloudpin only looks for the CLI on the PATH it started with, where it isn't, so it can't tell which account this command would use",
  fix: "put the CLI's folder on PATH before starting the agent, or run the command yourself",
};

/** Why a call stops: the variables by name, never a value. */
export const codeVarsStop = (names: string[]) => ({
  problem: `${names.join(", ")} ${names.length > 1 ? "are" : "is"} set by the command line and can make a program run code the line chose, so cloudpin won't start the CLI to ask, and can't tell which account this command would use`,
  fix: `set ${names.length > 1 ? "them" : "it"} before starting the agent, or run the command yourself`,
});
