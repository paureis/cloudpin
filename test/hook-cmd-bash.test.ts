import { describe, expect, it } from "vitest";
import { ENV, hook, pinned, RULE, run } from "./hook-cmd-fixture.js";

describe("read as bash: nothing, unless the name typed is .cmd or .bat (#168)", () => {
  it.each(["az group list --query 'x&kubectl'", "az group list --subs^cription other", "az group list --query '(a)'", "az group list %ZZP%", "vercel ls 'x&kubectl'"])("Git Bash runs the extensionless script: %s", async (command) => {
    expect((await hook(command, "Bash")).reason).not.toContain(RULE);
  });
  it.each([
    ["az.cmd group list --query 'x&kubectl'", "an unquoted &"],
    ["az.bat group list --query 'x&kubectl'", "an unquoted &"],
    ["./az.cmd group list --query 'x&kubectl'", "an unquoted &"],
    ["/c/bin/az.cmd group list --query 'x&kubectl'", "an unquoted &"],
    [`az.cmd group list --query 'a b"&kubectl get pods&"c'`, "an unquoted &"],
    // Git Bash writes each quote as \" and wraps the word: the quotes that keep it inside for PowerShell end it here.
    [`az.cmd group list --query 'a"&kubectl"'`, "an unquoted &"],
    [`az.cmd group list --query '"a&b"'`, "an unquoted &"],
    ["az.cmd group list --subs^cription other", "an unquoted ^"],
    ["az.cmd group list %ZZP%", "%NAME%"],
    ["az.cmd group list --query '(a)'", "an unquoted )"],
    ["az.cmd group list --query $'x\\ny' --subscription pinned", "a newline"],
  ])("%s", async (command, what) => {
    const { decision, reason } = await hook(command, "Bash");
    expect(decision).toBe("deny");
    expect(reason).toContain(what);
  });
  it.each(["az.cmd group list", "az.cmd group list --query 'x&kubectl get pods'", "az.cmd group list --query 'a)b c'"])("Git Bash adds the quotes: %s", async (command) => {
    expect((await hook(command, "Bash")).decision).toBe("allow");
  });
  it("gh.exe typed in bash", async () => {
    expect((await hook("gh.exe pr list --jq 'a|b'", "Bash")).decision).toBe("allow");
  });
  it("a PowerShell line inside bash is read as PowerShell", async () => {
    expect((await hook(`powershell -Command "az group list --query 'x&kubectl'"`, "Bash")).reason).toContain(RULE);
  });
});

describe("an agent that doesn't name its shell is read both ways on Windows (#168)", () => {
  const cursor = async (command: string, platform: NodeJS.Platform = "win32") => JSON.parse(await run("cursor", { command, cwd: pinned }, ENV, platform)).permission as string;
  it("the PowerShell reading stops it", async () => {
    expect(await cursor("az group list --query 'x&kubectl'")).toBe("deny");
  });
  it("gh.exe passes", async () => {
    expect(await cursor("gh pr list --jq 'a|b'")).toBe("allow");
  });
  it("elsewhere it is bash", async () => {
    expect(await cursor("az group list --query 'x&kubectl'", "linux")).toBe("allow");
  });
  it("Codex's Bash tool, which says nothing of the shell", async () => {
    const out = await run("codex", { tool_name: "Bash", tool_input: { command: "az group list --query 'x&kubectl'" }, cwd: pinned }, ENV, "win32");
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });
  it("Copilot's powershell tool", async () => {
    const out = await run("copilot", { toolName: "powershell", toolArgs: JSON.stringify({ command: "az group list --query 'x&kubectl'" }), cwd: pinned }, ENV, "win32");
    expect(JSON.parse(out).permissionDecision).toBe("deny");
  });
  it("Copilot's bash tool", async () => {
    const out = await run("copilot", { toolName: "bash", toolArgs: JSON.stringify({ command: "az group list --query 'x&kubectl'" }), cwd: pinned }, ENV, "win32");
    expect(out).toBe("");
  });
});
