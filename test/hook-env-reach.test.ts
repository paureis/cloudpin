import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { explain } from "../src/explain.js";
import { guard } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { cloudpinTools } from "../src/mcp-tools.js";
import { findInvocations } from "../src/shellwords.js";
import { envFor } from "../src/user-env.js";
import { fakeDoctorHost } from "./fake-doctor-host.js";
import { ANYTHING, asked, bare, CALL, deps, hook, otherPin, PIN_USER, pinned, RIGHT, type Shell, WRONG } from "./hook-env-fixture.js";
import { tempDir } from "./tmp.js";

const SECRET = "fake-secret-value-for-the-test";

describe("a followed value reaches the identity lookup as export does, and is never printed (#163)", () => {
  it.each<[Shell, string]>([
    ["PowerShell", `\${env:GH_TOKEN}='${SECRET}'`],
    ["PowerShell", `Set-Item env:GH_TOKEN ${SECRET}`],
    ["PowerShell", `[Environment]::SetEnvironmentVariable('GH_TOKEN','${SECRET}')`],
    ["Bash", `export GH_TOKEN=${SECRET}`],
    ["Bash", `export GH_TOKEN+=${SECRET}`],
    ["Bash", `set -a; GH_TOKEN=${SECRET}`],
  ])("%s: %s", async (tool, line) => {
    asked.length = 0;
    const answer = await hook(`${line}; ${CALL}`, tool);
    expect(answer.decision).toBe("allow");
    expect(asked.map((a) => a.token)).toEqual([SECRET]);
  });

  it.each<[Shell, string]>([
    ["PowerShell", `\${env:GH_TOKEN}='${WRONG}'`],
    ["PowerShell", `Set-Item env:GH_TOKEN ${WRONG}`],
    ["PowerShell", `[Environment]::SetEnvironmentVariable('GH_TOKEN','${WRONG}')`],
  ])("the block doesn't print it: %s %s", async (tool, line) => {
    const answer = await hook(`${line}; gh pr list --repo x`, tool);
    expect(answer.decision).toBe("deny");
    expect(answer.reason).not.toContain(WRONG);
  });

  it("the variable the identity lookup reads is the one the cache keys on", async () => {
    const [inv] = findInvocations(`\${env:GH_TOKEN}='${SECRET}'; ${CALL}`, ["gh"], pinned, {}, "powershell");
    const env = envFor({}, inv!, { agent: true, platform: "linux" });
    expect(env.GH_TOKEN).toBe(SECRET);
    // The cache's own inputs name it, so a new value is a new key.
    const { github } = await import("../src/providers/github.js");
    expect(github.cacheInputs(env).env).toContain("GH_TOKEN");
    // Same shape as `export`: the rest of the invocation agrees.
    const [exported] = findInvocations(`export GH_TOKEN=${SECRET}; ${CALL}`, ["gh"], pinned, {}, "bash");
    expect(inv).toEqual(exported);
  });

  it("no reason names a value, in any can't-tell answer", async () => {
    for (const [tool, line] of [
      ["Bash", `export GH_TOKEN+=$(cat f); export X=${SECRET}; ${CALL}`],
      ["Bash", `export X=${SECRET}; . f; ${CALL}`],
      ["PowerShell", `$env:X='${SECRET}'; if ($c) { $env:GH_TOKEN='${SECRET}' }; ${CALL}`],
      ["PowerShell", `$env:X='${SECRET}'; . ./f.ps1; ${CALL}`],
    ] as [Shell, string][]) {
      const answer = await hook(line, tool);
      expect(answer.decision, line).toBe("deny");
      expect(answer.reason.split(line).join(""), line).not.toContain(SECRET);
    }
  });
});

describe("an agent setting cloudpin's own variables stays ignored, in every new form (#136) (#163)", () => {
  // Pinned so that the wrong account passes only under the environment "lax".
  const folder = realpathSync(tempDir("cloudpin-163-env-own-"));
  writeFileSync(
    join(folder, ".cloudpin.yml"),
    `environments:\n  strict:\n    github: { user: ${PIN_USER} }\n  lax:\n    github: { user: someone-else }\nbranches:\n  "*": strict\n`,
  );
  const wrong = { GH_TOKEN: WRONG, CLOUDPIN_ENV: "strict" };

  it("control: the user's own setting counts, and the wrong token is denied", async () => {
    expect((await hook(CALL, "Bash", wrong, folder)).decision).toBe("deny");
    expect((await hook(CALL, "Bash", { ...wrong, CLOUDPIN_ENV: "lax" }, folder)).decision).toBe("allow");
  });

  it.each<[Shell, string]>([
    ["Bash", "export CLOUDPIN_ENV=lax"],
    ["Bash", "set -a; CLOUDPIN_ENV=lax"],
    ["Bash", "export CLOUDPIN_ENV+=x"],
    ["Bash", "CLOUDPIN_ENV=; export CLOUDPIN_ENV+=lax"],
    ["Bash", "f(){ local -x CLOUDPIN_ENV=lax; }; f"],
    ["Bash", "declare -x CLOUDPIN_ENV; CLOUDPIN_ENV=lax"],
    ["Bash", "read CLOUDPIN_ENV"],
    ["Bash", "export -n CLOUDPIN_ENV"],
    ["PowerShell", "$env:CLOUDPIN_ENV='lax'"],
    ["PowerShell", "${env:CLOUDPIN_ENV}='lax'"],
    ["PowerShell", "$env:CLOUDPIN_ENV+='x'"],
    ["PowerShell", "Set-Item env:CLOUDPIN_ENV lax"],
    ["PowerShell", "si env:CLOUDPIN_ENV lax"],
    ["PowerShell", "Set-Content env:CLOUDPIN_ENV lax"],
    ["PowerShell", "New-Item env:CLOUDPIN_ENV -Value lax -Force"],
    ["PowerShell", "Remove-Item env:CLOUDPIN_ENV"],
    ["PowerShell", "Clear-Item env:CLOUDPIN_ENV"],
    ["PowerShell", "[Environment]::SetEnvironmentVariable('CLOUDPIN_ENV','lax')"],
    ["PowerShell", "if ($c) { $env:CLOUDPIN_ENV='lax' }"],
  ])("%s: %s", async (tool, line) => {
    for (const platform of ["linux", "win32"] as const) {
      const answer = await hook(`${line}; ${CALL}`, tool, wrong, folder, platform);
      expect(answer.decision, platform).toBe("deny");
      expect(answer.reason, platform).toContain("someone-else");
    }
  });

  it.each(["set-item env:cloudpin_env lax", "${env:cloudpin_env}='lax'", "[Environment]::SetEnvironmentVariable('Cloudpin_Env','lax')"])("in any spelling on Windows: %s", async (line) => {
    const answer = await hook(`${line}; ${CALL}`, "PowerShell", wrong, folder, "win32");
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain("someone-else");
  });

  it("CLOUDPIN_SKIP and CLOUDPIN_CONFIRM too", async () => {
    for (const [tool, line] of [
      ["Bash", "set -a; CLOUDPIN_SKIP=1"],
      ["PowerShell", "Set-Item env:CLOUDPIN_SKIP 1"],
      ["PowerShell", "${env:CLOUDPIN_SKIP}='1'"],
    ] as [Shell, string][]) {
      expect((await hook(`${line}; ${CALL}`, tool, { GH_TOKEN: WRONG })).decision, line).toBe("deny");
    }
  });
});

describe("a pin must be in play (owner decision, DESIGN.md) (#163)", () => {
  const lines: [Shell, string][] = [
    ["Bash", ". f"],
    ["Bash", "source f"],
    ["Bash", "export $(cat f)"],
    ["Bash", "read $V"],
    ["Bash", `set -a; GH_TOKEN=${WRONG}`],
    ["Bash", `export GH_TOKEN+=${WRONG}`],
    ["Bash", "export GH_TOKEN=$(cat f)"],
    ["PowerShell", ". ./f.ps1"],
    ["PowerShell", "if ($c) { $env:GH_TOKEN='x' }"],
    ["PowerShell", `\${env:GH_TOKEN}='${WRONG}'`],
    ["PowerShell", `Set-Item env:GH_TOKEN ${WRONG}`],
    ["PowerShell", "Remove-Item env:*"],
  ];

  it.each(lines)("%s: %s stops nothing with no pin file, and asks no CLI", async (tool, line) => {
    asked.length = 0;
    expect((await hook(`${line}; ${CALL}`, tool, {}, bare)).decision).toBe("allow");
    expect(asked).toEqual([]);
  });

  it.each(lines)("%s: %s stops nothing when the pin file doesn't pin this CLI", async (tool, line) => {
    asked.length = 0;
    expect((await hook(`${line}; ${CALL}`, tool, {}, otherPin)).decision).toBe("allow");
    expect(asked).toEqual([]);
  });

  it("control: a pinned folder stops them", async () => {
    for (const [tool, line] of lines) expect((await hook(`${line}; ${CALL}`, tool)).decision, line).toBe("deny");
  });

  it("a folder change decides which pin is in play", async () => {
    expect((await hook(`cd ${JSON.stringify(pinned)}; . f; ${CALL}`, "Bash", {}, bare)).reason).toContain(ANYTHING);
    expect((await hook(`cd ${JSON.stringify(bare)}; . f; ${CALL}`, "Bash", {}, pinned)).decision).toBe("allow");
  });

  it("guard itself: the mark stops only with a pin, after an exempt call", async () => {
    const req = { bin: "gh", args: ["pr", "list"], env: {}, mode: "agent" as const, envUnknown: true };
    expect(await guard({ ...req, cwd: pinned }, deps)).toMatchObject({ action: "block", uncertain: true });
    expect(await guard({ ...req, cwd: bare }, deps)).toMatchObject({ action: "allow", reason: "no-config" });
    expect(await guard({ ...req, cwd: otherPin }, deps)).toMatchObject({ action: "allow", reason: "not-pinned" });
    expect(await guard({ ...req, args: ["--version"], cwd: pinned }, deps)).toMatchObject({ action: "allow", reason: "exempt" });
    expect(await guard({ ...req, cwd: pinned, mode: "shell", env: { CLOUDPIN_SKIP: "1" } }, deps)).toMatchObject({ action: "allow", reason: "skipped" });
  });
});

describe("explain and cloudpin_check read the line as the hook does (#163)", () => {
  const check = (cwd: string) => cloudpinTools(deps, { cwd, env: {}, read: () => null, isDir: () => true, doctor: fakeDoctorHost }).find((t) => t.name === "cloudpin_check")!;
  const cases: [Shell, string, string][] = [
    ["Bash", `. f; ${CALL}`, "block"],
    ["Bash", `export $(cat f); ${CALL}`, "block"],
    ["Bash", `set -a; GH_TOKEN=${WRONG}; ${CALL}`, "block"],
    ["Bash", `set -a; GH_TOKEN=${RIGHT}; ${CALL}`, "allow"],
    ["Bash", `export GH_TOKEN+=${WRONG}; ${CALL}`, "block"],
    ["Bash", `(. f); ${CALL}`, "allow"],
    ["Bash", `. f; gh --version`, "allow"],
    ["PowerShell", `\${env:GH_TOKEN}='${WRONG}'; ${CALL}`, "block"],
    ["PowerShell", `\${env:GH_TOKEN}='${RIGHT}'; ${CALL}`, "allow"],
    ["PowerShell", `Set-Item env:GH_TOKEN ${WRONG}; ${CALL}`, "block"],
    ["PowerShell", `[Environment]::SetEnvironmentVariable('GH_TOKEN','${WRONG}'); ${CALL}`, "block"],
    ["PowerShell", `[Environment]::SetEnvironmentVariable('GH_TOKEN','${WRONG}','User'); ${CALL}`, "allow"],
    ["PowerShell", `if ($c) { $env:GH_TOKEN='x' }; ${CALL}`, "block"],
    ["PowerShell", `. ./f.ps1; ${CALL}`, "block"],
    ["PowerShell", `Remove-Item env:*; gh --version`, "allow"],
  ];

  it.each(cases)("%s: %s is %s", async (tool, line, verdict) => {
    const shell = tool === "Bash" ? "bash" : "powershell";
    const hooked = await hook(line, tool);
    expect(hooked.decision).toBe(verdict === "block" ? "deny" : "allow");
    const calls = await explain(line, { mode: "agent", cwd: pinned, env: {}, shell }, deps);
    expect(calls.map((c) => c.verdict)).toEqual([verdict]);
    const tools = (await check(pinned).call({ command: line, shell })) as { calls: { verdict: string }[] };
    expect(tools.calls.map((c) => c.verdict)).toEqual([verdict]);
  });

  it("with no pin file, explain allows too, and says nothing of a value", async () => {
    const calls = await explain(`export X=${SECRET}; . f; ${CALL}`, { mode: "agent", cwd: bare, env: {}, shell: "bash" }, deps);
    expect(calls.map((c) => c.verdict)).toEqual(["allow"]);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
  });

  it("explain's block gives the reason and a way out, naming no value", async () => {
    const [call] = await explain(`export X=${SECRET}; . f; ${CALL}`, { mode: "agent", cwd: pinned, env: {}, shell: "bash" }, deps);
    expect(call?.verdict).toBe("block");
    expect(call?.problems?.join(" ")).toContain(ANYTHING);
    expect(call?.fix).toBeTruthy();
    expect(JSON.stringify(call)).not.toContain(SECRET);
  });

  it("the unknown-shell reading on Windows checks both, so bash's own forms still stop", async () => {
    const input = (command: string) => JSON.stringify({ command, cwd: pinned });
    const out = await runHook(AGENTS.cursor, input(`. f; ${CALL}`), deps, {}, undefined, "win32");
    expect(JSON.parse(out!).permission).toBe("deny");
    const passes = await runHook(AGENTS.cursor, input(`echo x; ${CALL}`), deps, {}, undefined, "win32");
    expect(JSON.parse(passes!).permission).toBe("allow");
    // A shell it can't name reads ${env:X} the same in both readings, as it does $env:X.
    const curly = await runHook(AGENTS.cursor, input(`\${env:GH_TOKEN}='${RIGHT}'; ${CALL}`), deps, { GH_TOKEN: WRONG }, undefined, "win32");
    expect(JSON.parse(curly!).permission).toBe("allow");
  });
});
