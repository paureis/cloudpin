import { describe, expect, it } from "vitest";
import { BIN, deps, hook, resolveTo, RULE, sent } from "./hook-cmd-fixture.js";

describe("read as PowerShell, a CLI that resolves to .cmd: what cmd.exe would act on stops (#168)", () => {
  it.each([
    ["a bare & runs what follows", "az group list --query 'x&kubectl'", "an unquoted &"],
    ["& glued to a flag", "az group list --query='x&kubectl'", "an unquoted &"],
    ["& escaped by a backtick", "az group list x`&kubectl", "an unquoted &"],
    ["a variable's value", "$q='x&kubectl'; az group list --query $q", "an unquoted &"],
    ["an environment variable's value", "$env:Q='x&kubectl'; az group list --query $env:Q", "an unquoted &"],
    ["a space and quotes flip the state", `az group list --query 'a b"&kubectl get pods&"c'`, "an unquoted &"],
    ["a quote in one argument, a quote in the next", `az group list 'a"b' 'c"&kubectl'`, "an unquoted &"],
    ["an argument with a space, then a bare one", "az group list 'a b' 'c&kubectl'", "an unquoted &"],
    ["--% passes it as typed", "az group list --% --query x&kubectl", "an unquoted &"],
    ["--% with quotes that close early", `az group list --% --query "a b"&kubectl`, "an unquoted &"],
    ["--% with a single quote, which cmd.exe doesn't know", "az group list --% --query 'x&kubectl'", "an unquoted &"],
    ["a pipe", "az group list --query 'a|b'", "an unquoted |"],
    ["an output redirection", "az group list --query 'a>b'", "an unquoted >"],
    ["an input redirection", "az group list --query 'a<b'", "an unquoted <"],
    ["a caret makes the flag", "az group list --subs^cription other", "an unquoted ^"],
    ["a caret in a value", "az group list --query 'a^b'", "an unquoted ^"],
    ["--% with a caret", "az group list --% --subs^cription other", "an unquoted ^"],
    ["the parenthesis of the IF block", "az group list --query '(a)'", "an unquoted )"],
    ["a parenthesis, then &", "az group list --query 'a)&kubectl'", "an unquoted )"],
    ["%NAME% bare", "az group list %ZZP%", "%NAME%"],
    ["%NAME% in single quotes", "az group list --query '%ZZP%'", "%NAME%"],
    ["%NAME% where 5.1 adds quotes", "az group list --query 'q %ZZP%'", "%NAME%"],
    ["%NAME% inside embedded quotes", `az group list --query '"%ZZP%"'`, "%NAME%"],
    ["--% with %NAME%", "az group list --% --query %ZZP%", "%NAME%"],
    ["a newline cuts the line, and the flags after it", 'az group list "x`ny" --subscription pinned', "a newline"],
    ["a newline where 5.1 adds quotes", 'az group list "x`ny z" --subscription pinned', "a newline"],
    ["a carriage return, which cmd.exe drops", 'az group list --subs"`r"cription other', "a newline"],
    ["az.cmd typed", "az.cmd group list --query 'x&kubectl'", "an unquoted &"],
    ["AZ.CMD typed", "AZ.CMD group list --query 'x&kubectl'", "an unquoted &"],
    ["az.bat typed", "az.bat group list --query 'x&kubectl'", "an unquoted &"],
    ["a call operator and a typed .cmd", "& 'az.cmd' group list --query 'x&kubectl'", "an unquoted &"],
    ["inside a block", "if ($x) { az group list --query 'x&kubectl' }", "an unquoted &"],
    ["a full path, typed", "& 'C:\\bin\\az.cmd' group list --query 'x&kubectl'", "an unquoted &"],
  ])("%s", async (_why, command, what) => {
    const { decision, reason } = await hook(command);
    expect(decision).toBe("deny");
    expect(reason).toContain(RULE);
    expect(reason).toContain(what);
    // Stopped before any CLI is asked anything.
    expect(sent).toEqual([]);
  });
});

describe("read as PowerShell, a CLI that resolves to .cmd: what cmd.exe reads as text passes (#168)", () => {
  it.each([
    ["no special character", "az group list --query name"],
    ["a space makes 5.1 add quotes", "az group list --query 'x&kubectl get pods'"],
    ["a value with a space and a caret", "az group list --query 'a^b c'"],
    ["a value with a space and a parenthesis", "az group list --query 'a) b'"],
    ["a variable's value with a space", "$q='x&kubectl get pods'; az group list --query $q"],
    ["embedded quotes", `az group list --query '"a&b"'`],
    ["embedded quotes, with backticks", 'az group list --query "`"a&b`""'],
    ["embedded quotes around a parenthesis", `az group list --query '"a)"'`],
    ["embedded quotes around a caret", `az group list --query '"a^b"'`],
    ["an embedded pair around &", `az group list --query 'a"&"b'`],
    ["one quote opens, and & stays inside", `az group list --query 'a"&kubectl'`],
    ["a quote in one argument keeps the next inside", `az group list 'a"b' 'c&kubectl'`],
    ["--% with double quotes", `az group list --% --query "x&kubectl"`],
    ["--% with a caret in double quotes", `az group list --% --query "a^b"`],
    ["delayed expansion is off", "az group list --query '!ZZP!'"],
    ["one % alone", "az group list --query '50%'"],
    ["PowerShell's own statements", "az group list; ls"],
    ["PowerShell's own redirection", "az group list > out.txt"],
    ["PowerShell's own pipe", "az group list | Select-Object -First 1"],
  ])("%s", async (_why, command) => {
    const { decision, reason } = await hook(command);
    expect(reason).toBe("");
    expect(decision).toBe("allow");
    // Went on to the real check.
    expect(sent.some((s) => s[0] === "az")).toBe(true);
  });

  it("the block for the wrong account still comes", async () => {
    const wrong = async () => ({ code: 0, stdout: JSON.stringify({ id: "22222222-0000-0000-0000-000000000002", tenantId: "t", name: "x" }), stderr: "" });
    const { decision, reason } = await hook("az group list --query 'x&kubectl get pods'", "PowerShell", { deps: { ...deps(), exec: wrong } });
    expect(decision).toBe("deny");
    expect(reason).toContain("expected");
    expect(reason).not.toContain(RULE);
  });
});

describe("a CLI that isn't a .cmd stays unaffected, which is why the test matters (#168)", () => {
  const FILTERS = ["gh pr list --jq 'x&kubectl'", "gh pr list --jq 'a|b'", "gh pr list --jq 'a^b'", "gh pr list --jq 'a)'", "gh pr list --jq '%ZZP%'", "gh pr list --jq 'a>b'"];
  it.each(FILTERS)("gh.exe: %s", async (command) => {
    expect((await hook(command)).decision).toBe("allow");
  });
  it.each(FILTERS)("control, the same line when gh resolves to a .cmd: %s", async (command) => {
    resolveTo({ gh: `${BIN}gh.cmd` });
    const { decision, reason } = await hook(command);
    expect(decision).toBe("deny");
    expect(reason).toContain(RULE);
  });
  it("gh.exe typed", async () => {
    expect((await hook("gh.exe pr list --jq 'a|b'")).decision).toBe("allow");
  });
  it("an .exe found first", async () => {
    resolveTo({ az: `${BIN}az.exe` });
    expect((await hook("az group list --query 'x&kubectl'")).decision).toBe("allow");
  });
});

describe("only on Windows (#168)", () => {
  const STOPS = ["az group list --query 'x&kubectl'", "az group list --subs^cription other", "az group list --query '(a)'", "az group list --query '%ZZP%'", "az.cmd group list --query 'x&kubectl'"];
  it.each(["linux", "darwin"] as const)("%s: the lines that stop on Windows pass", async (platform) => {
    for (const command of STOPS) {
      expect((await hook(command, "PowerShell", { platform })).decision).toBe("allow");
      expect((await hook(command, "Bash", { platform })).decision).toBe("allow");
    }
  });
  it.each(STOPS)("control, on Windows: %s", async (command) => {
    expect((await hook(command, "PowerShell", { platform: "win32" })).decision).toBe("deny");
  });
  it("with no way to look a CLI up, nothing is read as a .cmd", async () => {
    const { onPath: _none, ...noLookup } = deps();
    expect((await hook("az group list --query 'x&kubectl'", "PowerShell", { deps: noLookup })).decision).toBe("allow");
  });
});
