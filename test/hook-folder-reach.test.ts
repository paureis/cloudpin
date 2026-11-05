import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { explain } from "../src/explain.js";
import { gitBashPath } from "../src/folder.js";
import { defaultFindConfig, type GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { cloudpinTools } from "../src/mcp-tools.js";
import { vercel } from "../src/providers/vercel.js";
import { findInvocations } from "../src/shellwords.js";
import { type Exec, UNKNOWN_FOLDER } from "../src/types.js";
import { fakeDoctorHost } from "./fake-doctor-host.js";
import { CALL, CANT_TELL, deps, hook, PINNED, root, type Shell, SUB_PIN } from "./hook-folder-fixture.js";
import { tempDir } from "./tmp.js";

describe("the folder feeds the provider as well as the pin file lookup (#163)", () => {
  const TEAMS = JSON.stringify({ teams: [{ id: "team_main", slug: "acme", current: true }, { id: "team_side", slug: "side", current: false }], pagination: {} });
  const teamExec: Exec = async () => ({ code: 0, stdout: TEAMS, stderr: "" });
  const link = (dir: string, org: string) => {
    mkdirSync(join(dir, ".vercel"), { recursive: true });
    writeFileSync(join(dir, ".vercel", "project.json"), JSON.stringify({ orgId: org, projectId: `prj_${org}` }));
  };
  // One pin file, at the top, so only the provider's reading of the folder's link can tell them apart.
  const top = realpathSync(tempDir("cloudpin-163-vercel-"));
  writeFileSync(join(top, ".cloudpin.yml"), "vercel:\n  team: team_main\n");
  link(top, "team_main");
  link(join(top, "sub"), "team_side");
  link(join(top, "other"), "team_main");
  const vercelDeps: GuardDeps = { providers: [vercel], exec: teamExec, findConfig: defaultFindConfig };

  async function run(command: string, tool: Shell): Promise<string> {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd: top });
    const out = await runHook(AGENTS.claude, input, vercelDeps, { VERCEL_TOKEN: "example-env-token" }, undefined, "linux");
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "allow";
  }

  it.each<[Shell, string]>([
    ["Bash", "cd -- DIR && vercel ls"],
    ["Bash", "cd -P DIR; vercel ls"],
    ["Bash", "pushd DIR; vercel ls"],
    ["Bash", 'D=DIR; cd "$D"; vercel ls'],
    ["PowerShell", "Set-Location DIR; vercel ls"],
    ["PowerShell", "cd -LiteralPath DIR; vercel ls"],
    ["PowerShell", "Push-Location DIR; vercel ls"],
  ])("%s: %s reads the link of the folder it moved to", async (tool, shape) => {
    expect(await run(shape.split("DIR").join("sub"), tool)).toBe("deny");
    expect(await run(shape.split("DIR").join("other"), tool)).toBe("allow");
  });

  it("control: at the top the link is the pinned team", async () => {
    expect(await run("vercel ls", "Bash")).toBe("allow");
  });
});

describe("explain and cloudpin_check agree with the hook (#163)", () => {
  const LINES: [string, Shell, "allow" | "block"][] = [
    [`cd -- sub && ${CALL}`, "Bash", "block"],
    [`cd -- other && ${CALL}`, "Bash", "allow"],
    [`pushd sub; pushd ../other; popd; ${CALL}`, "Bash", "block"],
    [`cd "$(cat f)"; ${CALL}`, "Bash", "block"],
    [`cd "$(cat f)"; az version`, "Bash", "allow"],
    [`(cd "$(cat f)"); ${CALL}`, "Bash", "allow"],
    [`Set-Location -Path sub; ${CALL}`, "PowerShell", "block"],
    [`Set-Location -Path other; ${CALL}`, "PowerShell", "allow"],
    [`Set-Location (Get-Item x); ${CALL}`, "PowerShell", "block"],
  ];
  const shellOf = (tool: Shell) => (tool === "Bash" ? "bash" : "powershell") as "bash" | "powershell";

  it.each(LINES)("%j", async (line, tool, verdict) => {
    expect((await hook(line, tool)).decision).toBe(verdict === "block" ? "deny" : "allow");
    const explained = await explain(line, { mode: "agent", cwd: root, env: {}, shell: shellOf(tool) }, deps);
    expect(explained.map((c) => c.verdict)).toEqual([verdict]);
    const tools = cloudpinTools(deps, { cwd: root, env: {}, read: () => null, isDir: () => true, doctor: fakeDoctorHost });
    const check = tools.find((t) => t.name === "cloudpin_check")!;
    const result = (await check.call({ command: line, shell: shellOf(tool) })) as { calls: { verdict: string }[] };
    expect(result.calls.map((c) => c.verdict)).toEqual([verdict]);
  });

  it("explain says where the call runs, or that it can't tell", async () => {
    const [moved] = await explain(`cd -- sub && ${CALL}`, { mode: "agent", cwd: root, env: {} }, deps);
    expect(moved!.cwd).toBe(join(root, "sub"));
    expect(moved!.pinFile).toBe(SUB_PIN);
    const [lost] = await explain(`cd "$(cat f)"; ${CALL}`, { mode: "agent", cwd: root, env: {} }, deps);
    expect(lost!.cwd).toBe(UNKNOWN_FOLDER);
    expect(lost!.pinFile).toBeUndefined();
    expect(lost!.problems?.[0]).toContain(CANT_TELL);
  });
});

describe("cloudpin switch after a folder it can't read (#163)", () => {
  it("still asks, and names no pins it can't know apply", async () => {
    const asked = await hook('cd "$(cat f)"; cloudpin switch');
    expect(asked.decision).toBe("ask");
    expect(asked.reason).not.toContain(".cloudpin.yml");
    expect(asked.reason).not.toContain(PINNED);
    // The control: from a folder it knows, the question names them.
    expect((await hook("cloudpin switch")).reason).toContain(PINNED);
  });
});

describe("what the parser makes of each (#163)", () => {
  const base = resolve("/work/app");
  const cwdOf = (line: string, env?: NodeJS.ProcessEnv) => findInvocations(line, ["gh"], base, env).map((c) => c.cwd);

  it("no folder change leaves cwd unset", () => {
    expect(cwdOf("gh pr list")).toEqual([undefined]);
    expect(cwdOf("cd -Path sub; gh pr list")).toEqual([undefined]);
    expect(cwdOf("(cd sub); gh pr list")).toEqual([undefined]);
  });

  it("each call in a line keeps its own folder", () => {
    expect(cwdOf('gh a; cd x; gh b; cd "$(y)"; gh c')).toEqual([undefined, resolve("/work/app/x"), UNKNOWN_FOLDER]);
  });

  it("reads a variable from the hook's environment as bash would split it", () => {
    expect(cwdOf("cd $D; gh a", { D: "one" })).toEqual([resolve("/work/app/one")]);
    expect(cwdOf("cd $D; gh a", { D: "one two" })).toEqual([UNKNOWN_FOLDER]);
    expect(cwdOf('cd "$D"; gh a', { D: "one two" })).toEqual([resolve("/work/app/one two")]);
    expect(cwdOf("cd $D; gh a", { D: "", HOME: resolve("/home/me") })).toEqual([resolve("/home/me")]);
  });

  it("$PWD and $OLDPWD are the line's, never the hook's", () => {
    expect(cwdOf('cd "$PWD/x"; gh a', { PWD: "/hook/folder" })).toEqual([resolve("/work/app/x")]);
    expect(cwdOf('cd "$OLDPWD"; gh a', { OLDPWD: "/hook/folder" })).toEqual([UNKNOWN_FOLDER]);
    expect(cwdOf('cd x; cd "$OLDPWD"; gh a', { OLDPWD: "/hook/folder" })).toEqual([base]);
  });
});

describe("gitBashPath: Git Bash's view of a Windows folder (#163)", () => {
  it("reads a drive from /c/x on Windows", () => {
    expect(gitBashPath("/c/Users/x", "win32")).toBe("C:/Users/x");
    expect(gitBashPath("/D/work", "win32")).toBe("D:/work");
    expect(gitBashPath("/c", "win32")).toBe("C:/");
    expect(gitBashPath("/c/", "win32")).toBe("C:/");
  });

  it("can't place another absolute path: Git Bash's mounts decide it", () => {
    expect(gitBashPath("/usr/local", "win32")).toBeUndefined();
    expect(gitBashPath("/", "win32")).toBeUndefined();
    expect(gitBashPath("/cygdrive/c", "win32")).toBeUndefined();
    expect(gitBashPath("/tmp/x", "win32")).toBeUndefined();
  });

  it("reads /tmp from %TEMP%, its mount in Git for Windows", () => {
    expect(gitBashPath("/tmp", "win32", "C:\\T")).toBe("C:\\T");
    expect(gitBashPath("/tmp/x", "win32", "C:\\T")).toBe("C:\\T/x");
    expect(gitBashPath("/tmpx", "win32", "C:\\T")).toBeUndefined();
    expect(gitBashPath("/tmp/x", "linux", "C:\\T")).toBe("/tmp/x");
  });

  it("leaves everything else alone", () => {
    expect(gitBashPath("//server/share", "win32")).toBe("//server/share");
    expect(gitBashPath("C:/x", "win32")).toBe("C:/x");
    expect(gitBashPath("sub", "win32")).toBe("sub");
    expect(gitBashPath("/c/x", "linux")).toBe("/c/x");
    expect(gitBashPath("/usr/local", "linux")).toBe("/usr/local");
  });

  it.runIf(process.platform === "win32")("the hook reads the /c/x form as the real folder", async () => {
    const posix = (dir: string) => `/${dir[0]!.toLowerCase()}${dir.slice(2).split("\\").join("/")}`;
    expect((await hook(`cd ${posix(join(root, "sub"))}; ${CALL}`)).reason).toContain(SUB_PIN);
    expect((await hook(`cd ${posix(join(root, "other"))}; ${CALL}`)).decision).toBe("allow");
  });
});
