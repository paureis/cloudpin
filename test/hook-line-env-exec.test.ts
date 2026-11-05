import { beforeEach, describe, expect, it } from "vitest";
import { explain } from "../src/explain.js";
import { guard } from "../src/guard.js";
import { cloudpinTools } from "../src/mcp-tools.js";
import { fakeDoctorHost } from "./fake-doctor-host.js";
import { bare, calls, deps, hook, otherPin, PIN_USER, pinned, SECRET, type Shell, state, WRONG_TOKEN } from "./hook-line-env-fixture.js";

beforeEach(() => {
  state.missing = false;
});

const CALL = "gh pr list";
const CAN_RUN = [
  // Node (nodejs.org/api/cli.html, NODE_OPTIONS: --require and --import are allowed; NODE_PATH).
  "NODE_OPTIONS", "NODE_PATH",
  // Python (docs.python.org/3/using/cmdline.html): the module path, the standard library, what runs at startup, user site, .pyc files.
  "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONUSERBASE", "PYTHONPYCACHEPREFIX", "PYTHONPLATLIBDIR", "PYTHONWARNINGS",
  // gcloud (gcloud topic startup): the interpreter and its flags.
  "CLOUDSDK_PYTHON", "CLOUDSDK_PYTHON_ARGS",
  // az: a config value's variable, AZURE_<SECTION>_<OPTION> (azure-cli-core extension/__init__.py).
  "AZURE_EXTENSION_DIR", "AZURE_EXTENSION_SYS_DIR", "AZURE_EXTENSION_DEV_SOURCES",
  // aws: a file holding credential_process (AWS SDKs and Tools Reference Guide; botocore session.full_config).
  "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
  // Where those files and the user site are looked for.
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA",
  // Shells and loaders (bash(1), ld.so(8), dyld(1)) and what a CLI's own shell is (nodejs.org child_process, Python subprocess).
  "BASH_ENV", "SHELLOPTS", "PS4", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "COMSPEC",
  // Wrapper scripts in other languages.
  "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB",
];

describe("a variable the line sets that can make a program run code stops the call before anything starts", () => {
  it.each(CAN_RUN)("%s", async (name) => {
    const stopped = await hook(`${name}=${SECRET} ${CALL}`);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(name);
    expect(stopped.reason).toContain("can't tell");
    expect(stopped.reason).not.toContain(SECRET);
    expect(calls).toEqual([]);
  });
});

describe("every form the line reader follows reaches the rule", () => {
  const value = `--require=${SECRET}`;
  it.each<[Shell, string]>([
    ["Bash", `NODE_OPTIONS=${value} ${CALL}`],
    ["Bash", `export NODE_OPTIONS=${value}; ${CALL}`],
    ["Bash", `export NODE_OPTIONS+=${value}; ${CALL}`],
    ["Bash", `declare -x NODE_OPTIONS=${value}; ${CALL}`],
    ["Bash", `set -a; NODE_OPTIONS=${value}; ${CALL}`],
    ["Bash", `env NODE_OPTIONS=${value} ${CALL}`],
    ["Bash", `env -u FOO NODE_OPTIONS=${value} ${CALL}`],
    ["Bash", `env -i NODE_OPTIONS=${value} ${CALL}`],
    ["Bash", `sudo NODE_OPTIONS=${value} ${CALL}`],
    ["Bash", `bash -c 'NODE_OPTIONS=${value} ${CALL}'`],
    ["Bash", `(export NODE_OPTIONS=${value}; ${CALL})`],
    ["Bash", `NODE_OPTIONS=$(cat f) ${CALL}`],
    ["Bash", `export NODE_OPTIONS=$OTHER; ${CALL}`],
    ["Bash", `NODE_OPTIONS=${value} cloudpin exec -- ${CALL}`],
    ["PowerShell", `$env:NODE_OPTIONS='${value}'; ${CALL}`],
    ["PowerShell", `\${env:NODE_OPTIONS}='${value}'; ${CALL}`],
    ["PowerShell", `$env:NODE_OPTIONS += '${value}'; ${CALL}`],
    ["PowerShell", `$env:NODE_OPTIONS = Get-Content f; ${CALL}`],
    ["PowerShell", `Set-Item env:NODE_OPTIONS '${value}'; ${CALL}`],
    ["PowerShell", `New-Item env:NODE_OPTIONS -Value '${value}'; ${CALL}`],
    ["PowerShell", `Set-Content env:NODE_OPTIONS '${value}'; ${CALL}`],
    ["PowerShell", `[Environment]::SetEnvironmentVariable('NODE_OPTIONS','${value}'); ${CALL}`],
    ["PowerShell", `pwsh -Command '$env:NODE_OPTIONS=''${value}''; ${CALL}'`],
  ])("%s: %s", async (tool, line) => {
    const stopped = await hook(line, { tool });
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain("NODE_OPTIONS");
    expect(stopped.reason).toContain("can't tell");
    expect(stopped.reason).not.toContain(SECRET);
    expect(calls).toEqual([]);
  });

  it("a plain assignment counts when the name is already exported, which is when the CLI gets it", async () => {
    expect((await hook(`NODE_OPTIONS=${value}; ${CALL}`, { env: { NODE_OPTIONS: "--no-warnings" } })).decision).toBe("deny");
    expect(calls).toEqual([]);
    // Not exported: a shell variable the CLI never sees.
    expect((await hook(`NODE_OPTIONS=${value}; ${CALL}`)).decision).toBe("allow");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.NODE_OPTIONS).toBeUndefined();
  });
});

describe("what stays as it was", () => {
  it.each([
    ["an exempt call", `NODE_OPTIONS=${SECRET} gh --version`],
    ["a login", `NODE_OPTIONS=${SECRET} gh auth status`],
    ["a command cloudpin doesn't guard", `NODE_OPTIONS=${SECRET} ls`],
  ])("%s passes and starts nothing", async (_, line) => {
    expect((await hook(line)).decision).toBe("allow");
    expect(calls).toEqual([]);
  });

  it.each([
    ["no pin in sight", bare],
    ["a pin for another CLI", otherPin],
  ])("%s: nothing stops and nothing runs", async (_, cwd) => {
    expect((await hook(`NODE_OPTIONS=${SECRET} ${CALL}`, { cwd })).decision).toBe("allow");
    expect(calls).toEqual([]);
  });

  it("a variable set before the agent started is the user's choice: the lookup gets it", async () => {
    const answer = await hook(CALL, { env: { NODE_OPTIONS: "--no-warnings", PYTHONPATH: "/lib" } });
    expect(answer.decision).toBe("allow");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.NODE_OPTIONS).toBe("--no-warnings");
    expect(calls[0]!.env.PYTHONPATH).toBe("/lib");
  });

  it("the line setting the value it already has is no change", async () => {
    expect((await hook(`NODE_OPTIONS=--no-warnings ${CALL}`, { env: { NODE_OPTIONS: "--no-warnings" } })).decision).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("a line taking a variable away starts the lookup without it", async () => {
    expect((await hook(`unset NODE_OPTIONS; ${CALL}`, { env: { NODE_OPTIONS: "--no-warnings" } })).decision).toBe("allow");
    expect(calls[0]!.env.NODE_OPTIONS).toBeUndefined();
  });

  it.each(["PYTHONUTF8=1", "PYTHONIOENCODING=utf-8", "NODE_NO_WARNINGS=1", "NODE_EXTRA_CA_CERTS=/ca.pem", "PAGER=cat", "GH_PAGER=cat", "FOO=bar", "ENV=x", "AZ_INSTALLER=x"])("%s runs no code: the lookup starts with it", async (set) => {
    expect((await hook(`${set} ${CALL}`)).decision).toBe("allow");
    expect(calls).toHaveLength(1);
    const [name, value] = set.split("=");
    expect(calls[0]!.env[name!]).toBe(value);
  });

  it("a variable that picks the account still does: a wrong one denies, after a lookup with it", async () => {
    const answer = await hook(`GH_TOKEN=${WRONG_TOKEN} ${CALL}`);
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain("someone-else");
    expect(calls).toHaveLength(1);
  });
});

describe("Windows reads a variable's name in any case", () => {
  it.each<[Shell, string]>([
    ["Bash", `node_options=${SECRET} ${CALL}`],
    ["PowerShell", `$env:node_options='${SECRET}'; ${CALL}`],
    ["PowerShell", `$env:Node_Options='${SECRET}'; ${CALL}`],
    ["PowerShell", `Set-Item env:pythonpath '${SECRET}'; ${CALL}`],
  ])("%s: %s stops there", async (tool, line) => {
    const stopped = await hook(line, { tool, platform: "win32" });
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).not.toContain(SECRET);
    expect(calls).toEqual([]);
  });

  it("a second spelling of a variable the environment has counts, whichever Node would keep", async () => {
    expect((await hook(`$env:node_options='${SECRET}'; ${CALL}`, { tool: "PowerShell", platform: "win32", env: { NODE_OPTIONS: "--no-warnings" } })).decision).toBe("deny");
    expect(calls).toEqual([]);
  });

  it("elsewhere another spelling is another variable: no program reads it", async () => {
    expect((await hook(`node_options=${SECRET} ${CALL}`, { platform: "linux" })).decision).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("a variable set before the agent started counts in any spelling, as the user's", async () => {
    expect((await hook(CALL, { platform: "win32", env: { Node_Options: "--no-warnings" } })).decision).toBe("allow");
    expect(calls).toHaveLength(1);
  });
});

describe("names known only by their start", () => {
  it.each(["DYLD_FALLBACK_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_ANYTHING"])("%s", async (name) => {
    expect((await hook(`${name}=x ${CALL}`)).decision).toBe("deny");
    expect(calls).toEqual([]);
  });

  it("PowerShell can't be read past an odd name, so a bash function exported that way stops as a name it can't read", async () => {
    const stopped = await hook(`Set-Item 'env:BASH_FUNC_gh%%' '() { x; }'; ${CALL}`, { tool: "PowerShell" });
    expect(stopped.decision).toBe("deny");
    expect(calls).toEqual([]);
  });
});

describe("explain and the MCP check agree with the hook, and start nothing", () => {
  const LINE = `NODE_OPTIONS=${SECRET} ${CALL}`;

  it.each(["agent", "shell"] as const)("explain in %s mode", async (mode) => {
    calls.length = 0;
    const [call] = await explain(LINE, { mode, cwd: pinned, env: {} }, { ...deps, platform: "linux" });
    expect(call!.verdict).toBe("block");
    expect(call!.problems!.join(" ")).toContain("NODE_OPTIONS");
    expect(JSON.stringify(call)).not.toContain(SECRET);
    expect(calls).toEqual([]);
  });

  it("explain of a PowerShell line, with a folded name on Windows", async () => {
    calls.length = 0;
    const [call] = await explain(`$env:node_options='${SECRET}'; ${CALL}`, { mode: "agent", cwd: pinned, env: {}, shell: "powershell" }, { ...deps, platform: "win32" });
    expect(call!.verdict).toBe("block");
    expect(calls).toEqual([]);
  });

  it("explain of argv words has no line: the environment is the caller's", async () => {
    calls.length = 0;
    const [call] = await explain(["gh", "pr", "list"], { mode: "shell", cwd: pinned, env: { NODE_OPTIONS: "--no-warnings" } }, { ...deps, platform: "linux" });
    expect(call!.verdict).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("cloudpin_check", async () => {
    const tools = cloudpinTools({ ...deps, platform: "linux" }, { cwd: pinned, env: {}, read: () => null, isDir: () => true, doctor: fakeDoctorHost });
    const check = tools.find((t) => t.name === "cloudpin_check")!;
    calls.length = 0;
    const answer = (await check.call({ command: LINE })) as { calls: { verdict: string; problems: string[] }[] };
    expect(answer.calls[0]!.verdict).toBe("block");
    expect(answer.calls[0]!.problems.join(" ")).toContain("NODE_OPTIONS");
    expect(JSON.stringify(answer)).not.toContain(SECRET);
    expect(calls).toEqual([]);
  });

  it("the same line on a right account still passes through each, as a control", async () => {
    const [call] = await explain(CALL, { mode: "agent", cwd: pinned, env: {} }, { ...deps, platform: "linux" });
    expect(call!.verdict).toBe("allow");
    expect(call!.identity?.user).toBe(PIN_USER);
  });
});

describe("cloudpin exec has no line to read: its environment is the person's", () => {
  it("the lookup starts with what the terminal has", async () => {
    calls.length = 0;
    const verdict = await guard({ bin: "gh", args: ["pr", "list"], env: { NODE_OPTIONS: "--no-warnings" }, cwd: pinned, mode: "shell" }, deps);
    expect(verdict.action).toBe("allow");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.NODE_OPTIONS).toBe("--no-warnings");
  });
});
