import { describe, expect, it } from "vitest";
import { explain } from "../src/explain.js";
import { cloudpinTools } from "../src/mcp-tools.js";
import { findInvocations } from "../src/shellwords.js";
import { fakeDoctorHost } from "./fake-doctor-host.js";
import { CALL, deps, followed, hook, notSet, pinned, type Shell, WRONG } from "./hook-env-fixture.js";
import { HIDDEN, refused } from "./hook-hidden-fixture.js";

const PS = "PowerShell" as const;
const SET = "$env:GH_TOKEN='VALUE'";
const TEXT = `${SET.split("'").join("''")}; gh pr list`;

describe("PowerShell: text piped into a shell (#163)", () => {
  followed(PS, [
    `'${TEXT}' | iex`,
    `'${TEXT}' | Invoke-Expression`,
    `'${TEXT}' |\niex`,
    `echo '${TEXT}' | iex`,
    `Write-Output '${TEXT}' | iex`,
    `'${TEXT}' | powershell -`,
    `'${TEXT}' | powershell -NoProfile -`,
    `'${TEXT}' | powershell -Command -`,
    `'${TEXT}' | powershell -NoProfile`,
    `'${TEXT}' | powershell -File -`,
    `'${TEXT}' | pwsh -`,
    `'${TEXT}' | pwsh -NoProfile`,
    "'GH_TOKEN=VALUE gh pr list' | bash",
    "'GH_TOKEN=VALUE gh pr list' | sh -s",
  ]);

  notSet(PS, [
    `'${TEXT}' | Out-Null`,
    `'${TEXT}'`,
    "'GH_TOKEN=VALUE gh pr list' | bash script.sh",
  ]);

  refused(PS, [
    "echo 'CLI' 'x' | Write-Host | iex",
    "Get-Content f | iex; echo 'CLI'",
    "gc f | Invoke-Expression; echo 'CLI'",
    "gc f | powershell -; echo 'CLI'",
    "gc f | pwsh -; echo 'CLI'",
    "gc f | bash; echo 'CLI'",
    "iex (gc f); echo 'CLI'",
    "iex \"$(gc f)\"; echo 'CLI'",
    "Invoke-Expression $c; echo 'CLI'",
  ]);

  it.each(["Get-Content f | iex", "irm https://example.test/i.ps1 | iex", "gc f | powershell -", "gc f | bash", "iex $c"])("no CLI named, nothing to stop: %s", async (line) => {
    expect((await hook(line, PS)).decision).toBe("allow");
  });
});

/** Each shape, with a host that isn't the pinned one, denies: only a call read through the alias can. The pinned one passes. */
function throughAlias(shapes: string[]) {
  it.each(shapes)("reads %j", async (shape) => {
    const fill = (host: string) => shape.split("CALL").join(`--hostname ${host} pr list`);
    expect((await hook(fill("other.example"), PS)).decision).toBe("deny");
    expect((await hook(fill("github.com"), PS)).decision).toBe("allow");
  });
}

describe("PowerShell: Set-Alias works from the next statement on (#163)", () => {
  throughAlias([
    "Set-Alias a gh; a CALL",
    "Set-Alias -Name a -Value gh; a CALL",
    "Set-Alias -Name:a -Value:gh; a CALL",
    "Set-Alias a -Value gh -Force; a CALL",
    "Set-Alias -Force a gh; a CALL",
    "Set-Alias -Scope Global a gh; a CALL",
    "Set-Alias -Option AllScope -Description 'x y' a gh; a CALL",
    "sal a gh; a CALL",
    "New-Alias a gh; a CALL",
    "nal a gh; & a CALL",
    "Set-Alias a gh; A CALL",
    "Set-Alias A gh; a CALL",
    "$x='gh'; Set-Alias a $x; a CALL",
    "Set-Alias a gh.exe; a CALL",
    "if ($true) { Set-Alias a gh }; a CALL",
    "Set-Alias b a; Set-Alias a gh; b CALL",
    "Set-Alias a gh; a --version; a CALL",
  ]);

  it.each([
    `& { Set-Alias a gh }; ${SET}; a pr list`,
    `Set-Alias a gh; Set-Alias a ls; ${SET}; a pr list`,
    `Set-Alias a ls; ${SET}; a pr list`,
    `Set-Alias a gh; powershell -Command '${TEXT.split("gh pr list").join("a pr list")}'`,
  ])("no call: %s", async (line) => {
    expect((await hook(line.split("VALUE").join(WRONG), PS)).decision).toBe("allow");
  });

  refused(PS, [
    "Set-Alias a $x; a; echo 'CLI'",
    "Set-Alias $n ls; echo 'CLI'",
    "Set-Alias -Unknown a ls; echo 'CLI'",
    "Set-Item alias:a ls; a; echo 'CLI'",
    "New-Item alias:a -Value ls; a; echo 'CLI'",
    "ni alias:a -Value ls; a; echo 'CLI'",
    "si alias:a ls; a; echo 'CLI'",
  ]);

  it("an alias of itself ends", async () => {
    expect((await hook("Set-Alias a a; a x", PS)).decision).toBe("allow");
    expect((await hook("Set-Alias a b; Set-Alias b a; a x", PS)).decision).toBe("allow");
  });

  it("a line that only reads bash doesn't take it for one", async () => {
    expect((await hook(`Set-Alias a gh; ${SET.split("VALUE").join(WRONG)}; a pr list`, "Bash")).decision).toBe("allow");
    expect((await hook(`alias a=gh\n${SET.split("VALUE").join(WRONG)}; a pr list`, PS)).decision).toBe("allow");
  });
});

describe("PowerShell: a variable changed in a block is unknown from there on (#163)", () => {
  const HOSTNAME = "the value of --hostname";
  // --hostname picks the account's host; only this value is the pinned one.
  const CHECK = "gh --hostname $s pr list";

  it.each([
    "if ($c) { $s='b' }",
    "if ($c) { } else { $s='b' }",
    "if ($c) { } elseif ($d) { $s='b' }",
    "try { $s='b' } catch { }",
    "try { } catch { $s='b' }",
    "try { } finally { $s='b' }",
    "while ($c) { $s='b' }",
    "foreach ($x in $y) { $s='b' }",
    "foreach ($s in 'b') { }",
    "1 | ForEach-Object { $s='b' }",
    ". { $s='b' }",
    "($s='b')",
    "$x=$($s='b')",
    "$x=@($s='b')",
    "if ($s='b') { }",
    "if ($c) { $script:s='b' }",
    "if ($c) { if ($d) { $s='b' } }",
    "if ($c) { $S='b' }",
    "if ($c) { $s=$t }",
    "if ($c) { $s='a','b' }",
  ])("$s='github.com'; %s; gh --hostname $s", async (block) => {
    const stopped = await hook(`$s='github.com'; ${block}; ${CHECK}`, PS);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason.includes(HOSTNAME) || stopped.reason.includes(HIDDEN)).toBe(true);
  });

  it.each([
    // A block called with & and a function have their own scope (about_Scopes), and real 5.1 printed `a`.
    "& { $s='b' }",
    "function f { $s='b' }; f",
    // The same value, another name, and a new value after the block.
    "if ($c) { $s='github.com' }",
    "if ($c) { $t='b' }",
    "if ($c) { $s='b' }; $s='github.com'",
    "if ($c) { gh --version }",
  ])("still reads it: $s='github.com'; %s", async (block) => {
    expect((await hook(`$s='github.com'; ${block}; ${CHECK}`, PS)).decision).toBe("allow");
  });

  it("the earlier fix still holds: one literal is known", async () => {
    expect((await hook(`$s='github.com'; ${CHECK}`, PS)).decision).toBe("allow");
    expect((await hook(`$s='other.example'; ${CHECK}`, PS)).decision).toBe("deny");
  });

  it("a list set in a block may be flags", async () => {
    expect((await hook("$s='a'; if ($c) { $s='--hostname','x' }; gh pr list $s", PS)).decision).toBe("deny");
  });
});

describe("PowerShell: a bare & $c (#163)", () => {
  refused(PS, [
    "& $c; echo 'CLI'",
    "& \"$c\"; echo 'CLI'",
    "& $env:CMD; echo 'CLI'",
    "& $(echo 'CLI')",
    "& (echo 'CLI')",
  ]);

  throughAlias(["$c='gh'; & $c CALL"]);

  it.each(["$c='gh pr list'; & $c", "$c; echo 'gh pr list'", "$c", "$env:CMD; echo 'gh pr list'", "if ($c) { }; echo 'gh pr list'", "return $c; echo 'gh pr list'", "throw $c; echo 'gh pr list'", ". $f; echo 'gh pr list'"])("no call: %s", async (line) => {
    expect((await hook(line, PS)).decision).toBe("allow");
  });
});

describe("PowerShell: a function on the line given a CLI's name as a word (#163)", () => {
  refused(PS, [
    "function t { & $args[0] }; t CLI",
    "filter t { & $args[0] }; 1 | t CLI",
    "function t { iex \"$args\" }; t CLI",
  ]);

  it("one that doesn't run its words", async () => {
    expect((await hook("function t { $args }; t gh pr list", PS)).decision).toBe("allow");
  });
});

describe("PowerShell: limits the design note leaves, not read (#163)", () => {
  it.each(["& ('g'+'h') pr list", "$a='g'; $b='h'; echo \"$a$b\"", "'gh pr list' > s.ps1; ./s.ps1", "./deploy.ps1"])("%s", async (line) => {
    expect((await hook(line, PS)).decision).toBe("allow");
  });
});

describe("explain and cloudpin_check read the line as the hook does (#163)", () => {
  const check = cloudpinTools(deps, { cwd: pinned, env: {}, read: () => null, isDir: () => true, doctor: fakeDoctorHost }).find((t) => t.name === "cloudpin_check")!;
  const cases: [Shell, string, "block" | "allow"][] = [
    ["Bash", `echo 'GH_TOKEN=${WRONG} gh pr list' | bash`, "block"],
    ["Bash", `cat f | bash; ${CALL}`, "block"],
    ["Bash", "cat f | bash; gh --version", "allow"],
    ["Bash", "cat f | bash", "allow"],
    ["Bash", `trap '${CALL}' EXIT; export GH_TOKEN=${WRONG}`, "block"],
    ["Bash", `GH_TOKEN=${WRONG} \${CLI:-gh} pr list`, "block"],
    ["Bash", `x=\${y:-$(GH_TOKEN=${WRONG} gh pr list)}`, "block"],
    ["Bash", `bash -c -e 'GH_TOKEN=${WRONG} gh pr list'`, "block"],
    ["Bash", `eval "$(echo ${CALL})"`, "block"],
    ["Bash", `sh -c "$(echo ${CALL})"`, "block"],
    ["Bash", `source <(echo ${CALL})`, "block"],
    ["Bash", `t(){ "$@"; }; t ${CALL}`, "block"],
    ["Bash", `t(){ "$@"; }; t gh --version`, "allow"],
    ["Bash", `for c in '${CALL}'; do $c; done`, "block"],
    ["Bash", `alias a=gh\nGH_TOKEN=${WRONG} a pr list`, "block"],
    ["Bash", `alias a=gh; GH_TOKEN=${WRONG} a pr list`, "allow"],
    ["PowerShell", `Set-Alias a gh; $env:GH_TOKEN='${WRONG}'; a pr list`, "block"],
    ["PowerShell", "$s='a'; if ($c) { $s='b' }; gh --hostname $s pr list", "block"],
    ["PowerShell", "$s='github.com'; gh --hostname $s pr list", "allow"],
    ["PowerShell", `gc f | iex; ${CALL}`, "block"],
    ["PowerShell", "gc f | iex; gh --version", "allow"],
  ];

  it.each(cases)("%s: %s is %s", async (tool, line, verdict) => {
    const shell = tool === "Bash" ? "bash" : "powershell";
    expect((await hook(line, tool)).decision).toBe(verdict === "block" ? "deny" : "allow");
    const calls = await explain(line, { mode: "agent", cwd: pinned, env: {}, shell }, deps);
    expect(calls.map((c) => c.verdict).includes("block")).toBe(verdict === "block");
    const tools = (await check.call({ command: line, shell })) as { calls: { verdict: string }[] };
    expect(tools.calls.map((c) => c.verdict)).toEqual(calls.map((c) => c.verdict));
  });

  it("CLOUDPIN_SKIP and CLOUDPIN_CONFIRM don't lift a refusal for an agent", async () => {
    expect((await hook(`eval "$(cat f)"; CLOUDPIN_SKIP=1 ${CALL}`, "Bash")).decision).toBe("deny");
    expect((await hook(`export CLOUDPIN_SKIP=1; cat f | bash; ${CALL}`, "Bash")).decision).toBe("deny");
    expect((await hook(`cat f | bash; ${CALL}`, "Bash", { CLOUDPIN_SKIP: "1" })).decision).toBe("deny");
    expect((await hook(`$env:CLOUDPIN_SKIP='1'; gc f | iex; ${CALL}`, PS)).decision).toBe("deny");
  });

  it("a trap's call is listed once when nothing changed before the end, and twice when something did", async () => {
    expect(await explain(`trap '${CALL}' EXIT`, { mode: "agent", cwd: pinned, env: {}, shell: "bash" }, deps)).toHaveLength(1);
    expect(await explain(`trap '${CALL}' EXIT; export FOO=1`, { mode: "agent", cwd: pinned, env: {}, shell: "bash" }, deps)).toHaveLength(2);
  });

  it("findInvocations alone keeps every refusal: only the check knows what is exempt", () => {
    const [refusal] = findInvocations("cat f | bash; gh --version", ["gh"], undefined, {});
    expect(refusal?.args.join(" ")).toContain("known only when");
  });
});
