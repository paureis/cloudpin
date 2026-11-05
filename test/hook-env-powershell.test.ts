import { describe, expect, it } from "vitest";
import { asked, CALL, followed, hook, NAMED, notSet, refused, refusedByName, RIGHT, WRONG } from "./hook-env-fixture.js";

const PS = "PowerShell" as const;

describe("PowerShell: every literal way to set a variable is followed (#163)", () => {
  followed(PS, [
    "$env:GH_TOKEN='VALUE'",
    "$env:GH_TOKEN = 'VALUE'",
    "$env:GH_TOKEN ='VALUE'",
    "$env:GH_TOKEN= 'VALUE'",
    '$env:GH_TOKEN="VALUE"',
    "$ENV:GH_TOKEN='VALUE'",
    "${env:GH_TOKEN}='VALUE'",
    "${env:GH_TOKEN} = 'VALUE'",
    "${ENV:GH_TOKEN}='VALUE'",
    "${env:GH_TOKEN} ='VALUE'",
    "[string]$env:GH_TOKEN='VALUE'",
    "[string]${env:GH_TOKEN}='VALUE'",
    "$env:GH_TOKEN+='VALUE'",
    "$env:GH_TOKEN += 'VALUE'",
    "${env:GH_TOKEN}+='VALUE'",
    "$s='VALUE'; $env:GH_TOKEN=$s",
    '$s=\'VALUE\'; $env:GH_TOKEN="$s"',
    '$s=\'VALUE\'; ${env:GH_TOKEN}="x$s"',
    "Set-Item env:GH_TOKEN VALUE",
    "Set-Item env:GH_TOKEN 'VALUE'",
    "Set-Item env:GH_TOKEN '-VALUE'",
    "$n='GH_TOKEN'; Set-Item -Path:env:$n VALUE",
    "Remove-Item env:GH_TOKEN; New-Item env:GH_TOKEN -Value VALUE",
    'Set-Item env:GH_TOKEN "VALUE"',
    "set-item ENV:GH_TOKEN VALUE",
    "Set-Item Env:\\GH_TOKEN VALUE",
    "Set-Item env:/GH_TOKEN VALUE",
    "Set-Item -Path env:GH_TOKEN -Value VALUE",
    "Set-Item -Value VALUE -Path env:GH_TOKEN",
    "Set-Item -LiteralPath env:GH_TOKEN -Value VALUE",
    "Set-Item env:GH_TOKEN -Value VALUE",
    "Set-Item env:GH_TOKEN VALUE -ErrorAction Stop",
    "Set-Item env:GH_TOKEN VALUE -Force",
    "si env:GH_TOKEN VALUE",
    "$s='VALUE'; Set-Item env:GH_TOKEN $s",
    "$p='env:GH_TOKEN'; Set-Item $p VALUE",
    "Set-Content env:GH_TOKEN VALUE",
    "Set-Content -Path env:GH_TOKEN -Value VALUE",
    "sc env:GH_TOKEN VALUE",
    "New-Item env:GH_TOKEN -Value VALUE",
    "New-Item env:GH_TOKEN -Value VALUE -Force",
    "New-Item -Path env: -Name GH_TOKEN -Value VALUE",
    "New-Item -Name GH_TOKEN -Path env: -Value VALUE -Force",
    "ni env:GH_TOKEN -Value VALUE",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE')",
    "[System.Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE')",
    "[environment]::setenvironmentvariable('GH_TOKEN','VALUE')",
    '[Environment]::SetEnvironmentVariable("GH_TOKEN","VALUE")',
    "[Environment]::SetEnvironmentVariable('GH_TOKEN', 'VALUE')",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE,x')",
    "[Environment]::SetEnvironmentVariable( 'GH_TOKEN' , 'VALUE' )",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE','Process')",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE','process')",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE',[EnvironmentVariableTarget]::Process)",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE',[System.EnvironmentVariableTarget]::Process)",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE',0)",
    "$null = [Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE')",
    "[void][Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE')",
  ]);

  notSet(PS, [
    "if ($true) { $s='x' }",
    "Set-Variable env:GH_TOKEN VALUE",
    "Set-Item env:MY-VAR.A VALUE",
    "Set-Item Variable:GH_TOKEN VALUE",
    "Set-Content notes.txt 'env:GH_TOKEN'",
    "Set-Content env.txt VALUE",
    "Set-Item env.txt VALUE",
    "Add-Content env:GH_TOKEN VALUE",
    "Clear-Content env:GH_TOKEN",
    "Move-Item env:FOO env:GH_TOKEN",
    "Remove-Item env.txt",
    // A User or Machine target goes to the registry: it doesn't reach this process (Environment.SetEnvironmentVariable docs).
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE','User')",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE','Machine')",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE','machine')",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE',[EnvironmentVariableTarget]::User)",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE',[System.EnvironmentVariableTarget]::Machine)",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE',1)",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','VALUE',2)",
    "[Environment]::GetEnvironmentVariable('GH_TOKEN','VALUE')",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN',(Get-Content 'a','VALUE'),'User')",
  ]);

  it("+= adds to what the variable holds", async () => {
    const value = async (line: string, env: NodeJS.ProcessEnv = {}) => {
      asked.length = 0;
      await hook(`${line}; ${CALL}`, PS, env);
      return asked[0]?.token;
    };
    expect(await value("$env:GH_TOKEN+='b'")).toBe("b");
    expect(await value("$env:GH_TOKEN+='b'", { GH_TOKEN: "a" })).toBe("ab");
    expect(await value("$env:GH_TOKEN='c'; $env:GH_TOKEN+='b'", { GH_TOKEN: "a" })).toBe("cb");
    expect(await value("$env:gh_token+='b'", { GH_TOKEN: "a" })).toBe("a");
    expect(await value("Remove-Item env:GH_TOKEN; $env:GH_TOKEN+='b'", { GH_TOKEN: "a" })).toBe("b");
  });

  it("a value that holds $ in single quotes is that text", async () => {
    asked.length = 0;
    await hook(`$env:GH_TOKEN='$x'; ${CALL}`, PS);
    expect(asked[0]?.token).toBe("$x");
  });

  it("a command on the right of the = is read as the call it is", async () => {
    expect((await hook(`$env:FOO = gh pr list`, PS, { GH_TOKEN: WRONG })).decision).toBe("deny");
    expect((await hook(`$env:FOO = gh pr list`, PS, { GH_TOKEN: RIGHT })).decision).toBe("allow");
  });

  it("a variable a call can't reach stays out: New-Item on one that exists fails, without -Force", async () => {
    expect((await hook(`New-Item env:GH_TOKEN -Value ${WRONG}; ${CALL}`, PS, { GH_TOKEN: RIGHT })).decision).toBe("allow");
    expect((await hook(`New-Item env:GH_TOKEN -Value ${WRONG} -Force; ${CALL}`, PS, { GH_TOKEN: RIGHT })).decision).toBe("deny");
    expect((await hook(`New-Item env:gh_token -Value ${WRONG}; ${CALL}`, PS, { GH_TOKEN: RIGHT })).decision).toBe("allow");
    expect((await hook(`$env:GH_TOKEN='a'; New-Item env:GH_TOKEN -Value ${WRONG}; ${CALL}`, PS)).decision).toBe("allow");
  });
});

describe("PowerShell: every literal way to remove a variable is followed (#163)", () => {
  const env = { GH_TOKEN: WRONG };
  it.each([
    "Remove-Item env:GH_TOKEN",
    "remove-item ENV:GH_TOKEN",
    "Remove-Item Env:\\GH_TOKEN",
    "Remove-Item -Path env:GH_TOKEN",
    "Remove-Item -LiteralPath env:GH_TOKEN",
    "Remove-Item env:GH_TOKEN -ErrorAction SilentlyContinue",
    "Remove-Item env:GH_TOKEN -ea 0",
    "Remove-Item -Path env:GH_TOKEN -Force",
    "ri env:GH_TOKEN",
    "rm env:GH_TOKEN",
    "del env:GH_TOKEN",
    "erase env:GH_TOKEN",
    "rd env:GH_TOKEN",
    "rmdir env:GH_TOKEN",
    "Clear-Item env:GH_TOKEN",
    "cli env:GH_TOKEN",
    "Set-Item env:GH_TOKEN",
    "Set-Item env:GH_TOKEN ''",
    "Set-Item -Path env:GH_TOKEN -Value ''",
    "Set-Item env:GH_TOKEN $null",
    "Set-Content env:GH_TOKEN ''",
    "$env:GH_TOKEN=''",
    "$env:GH_TOKEN=$null",
    "${env:GH_TOKEN}=$null",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN','')",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN',$null)",
    "[Environment]::SetEnvironmentVariable('GH_TOKEN',$null,'Process')",
  ])("%s", async (line) => {
    expect((await hook(CALL, PS, env)).decision).toBe("deny");
    asked.length = 0;
    expect((await hook(`${line}; ${CALL}`, PS, env)).decision).toBe("allow");
    expect(asked[0]?.token).toBeUndefined();
    expect((await hook(`${line}; $env:GH_TOKEN='${WRONG}'; ${CALL}`, PS, env)).decision).toBe("deny");
  });

  it("removes what the line set, and only the name it says", async () => {
    expect((await hook(`$env:GH_TOKEN='${WRONG}'; Remove-Item env:GH_TOKEN; ${CALL}`, PS)).decision).toBe("allow");
    expect((await hook(`$env:GH_TOKEN='${WRONG}'; Remove-Item env:gh_token; ${CALL}`, PS)).decision).toBe("allow");
    expect((await hook(`Remove-Item env:FOO; ${CALL}`, PS, env)).decision).toBe("deny");
    expect((await hook(`[Environment]::SetEnvironmentVariable('GH_TOKEN',$null,'User'); ${CALL}`, PS, env)).decision).toBe("deny");
  });

  it("a name is one variable in any spelling", async () => {
    for (const platform of ["linux", "win32"] as const) {
      expect((await hook(`Remove-Item env:gh_token; ${CALL}`, PS, env, undefined, platform)).decision, platform).toBe("allow");
      expect((await hook(`Set-Item ENV:gh_token; ${CALL}`, PS, env, undefined, platform)).decision, platform).toBe("allow");
      expect((await hook(`Set-Item env:FOO; ${CALL}`, PS, env, undefined, platform)).decision, platform).toBe("deny");
    }
  });
});

describe("PowerShell: on Windows names fold, in every new form (#119, #136)", () => {
  it.each(["Set-Item env:gh_token VALUE", "${env:gh_token}='VALUE'", "[Environment]::SetEnvironmentVariable('gh_token','VALUE')", "$env:gh_token+='VALUE'"])("%s", async (shape) => {
    const line = `${shape.split("VALUE").join(WRONG)}; ${CALL}`;
    expect((await hook(line, PS, {}, undefined, "win32")).decision).toBe("deny");
    expect((await hook(`${shape.split("VALUE").join(RIGHT)}; ${CALL}`, PS, {}, undefined, "win32")).decision).toBe("allow");
    // On Linux they are other variables, which pick nothing.
    expect((await hook(line, PS, {}, undefined, "linux")).decision).toBe("allow");
  });
});

describe("PowerShell: a value only known when it runs stops the variable that picks the account (#160)", () => {
  refusedByName(PS, [
    "${env:NAME}=$(Get-Content f)",
    "${env:NAME}=(Get-Content f)",
    '${env:NAME}="x$y"',
    "$env:NAME+=$y",
    "[string]$env:NAME=$y",
    "$env:NAME-='y'",
    "$env:NAME=$y; $env:NAME+='b'",
    "Remove-Item env:NAME x",
    "New-Item env:NAME x -Value y",
    "$env:NAME='a','b'",
    "$env:NAME = 'a' + 'b'",
    "Set-Item env:NAME $y",
    "Set-Item env:NAME (Get-Content f)",
    "Set-Item env:NAME $(Get-Content f)",
    'Set-Item env:NAME "x$y"',
    "Set-Item env:NAME a,b",
    "Set-Item env:NAME a b",
    "Set-Item env:NAME -Value $y",
    "Set-Item env:NAME x -WhatIf",
    "Set-Item env:NAME x -Confirm",
    "Set-Item env:NAME -Value:x",
    "Set-Item -Value:$y env:NAME",
    "'x' | Set-Item env:NAME",
    "$y | Set-Item env:NAME",
    "'x' | Set-Content env:NAME",
    "Set-Content env:NAME",
    "Set-Content env:NAME $y",
    "New-Item env:NAME -Value $y",
    "New-Item env:NAME",
    "ni -Path env: -Name NAME -Value $y",
    "Remove-Item env:NAME -WhatIf",
    "[Environment]::SetEnvironmentVariable('NAME',$y)",
    '[Environment]::SetEnvironmentVariable(\'NAME\',"x$y")',
    "[Environment]::SetEnvironmentVariable('NAME',(Get-Content f))",
    "[Environment]::SetEnvironmentVariable('NAME','x',$t)",
    "[Environment]::SetEnvironmentVariable('NAME','x','Nonsense')",
    "[Environment]::SetEnvironmentVariable('NAME')",
  ]);
});

describe("PowerShell: a set inside a block might run, so the name can't tell (#163)", () => {
  refusedByName(PS, [
    "if ($c) { $env:NAME='x' }",
    "if ($c) { ${env:NAME}='x' }",
    "if ($c) { Set-Item env:NAME x }",
    "if ($c) { Remove-Item env:NAME }",
    "if ($c) { [Environment]::SetEnvironmentVariable('NAME','x') }",
    "if ($true) { $env:NAME='x' } else { $env:NAME='y' }",
    "& { $env:NAME='x' }",
    ". { $env:NAME='x' }",
    "foreach ($i in 1,2) { $env:NAME='x' }",
    "function f { $env:NAME='x' }",
    "try { $env:NAME='x' } catch { }",
    "1,2 | ForEach-Object { $env:NAME='x' }",
    "($env:NAME='x')",
    "$($env:NAME='x')",
    "@($env:NAME='x')",
    "$x = ($env:NAME='x')",
    "if ($c) { if ($d) { $env:NAME='x' } }",
  ]);

  it("inside the block itself the call sees the value", async () => {
    expect((await hook(`& { $env:GH_TOKEN='${WRONG}'; ${CALL} }`, PS)).decision).toBe("deny");
    expect((await hook(`& { $env:GH_TOKEN='${RIGHT}'; ${CALL} }`, PS)).decision).toBe("allow");
    expect((await hook(`if ($c) { $env:GH_TOKEN='${RIGHT}'; ${CALL} }`, PS)).decision).toBe("allow");
  });

  it("a call before the block isn't affected, nor a block that sets nothing", async () => {
    expect((await hook(`${CALL}; if ($c) { $env:GH_TOKEN='x' }`, PS)).decision).toBe("allow");
    expect((await hook(`if ($c) { echo x }; ${CALL}`, PS)).decision).toBe("allow");
    expect((await hook(`& { $x=1 }; ${CALL}`, PS)).decision).toBe("allow");
    expect((await hook(`$env:GH_TOKEN='${RIGHT}'; if ($c) { echo x }; ${CALL}`, PS)).decision).toBe("allow");
    expect((await hook(`$env:GH_TOKEN='${WRONG}'; if ($c) { echo x }; ${CALL}`, PS)).decision).toBe("deny");
  });

  it("a block that sets a value the same as outside is still only a value it has", async () => {
    expect((await hook(`$env:GH_TOKEN='${RIGHT}'; if ($c) { $env:GH_TOKEN='${RIGHT}' }; ${CALL}`, PS)).decision).toBe("allow");
  });
});

describe("PowerShell: what only the shell can read makes later calls can't tell (#163)", () => {
  refused(PS, [
    ". ./f.ps1",
    ". $f",
    ". (Join-Path x y)",
    "Set-Item env:$n x",
    'Set-Item "env:$n" x',
    "Set-Item env:GH_* x",
    "Set-Item -Path env:FOO,env:GH_TOKEN -Value x",
    "Set-Item -Path:env:FOO*",
    "Set-Item env:FOO?",
    "Remove-Item env:*",
    "Remove-Item env:GH_*",
    "Remove-Item env:$n",
    "Remove-Item -Path env:FOO, env:GH_TOKEN",
    "Remove-Item x.txt, env:GH_TOKEN",
    "Remove-Item -Path x.txt,env:GH_TOKEN",
    "Remove-Item Env:\\$n",
    "New-Item -Path env: -Name $n -Value x",
    "New-Item env:$n -Value x",
    "Rename-Item env:FOO GH_TOKEN",
    "rni env:FOO GH_TOKEN",
    "ren env:FOO GH_TOKEN",
    "Copy-Item env:FOO env:GH_TOKEN",
    "cpi env:FOO env:GH_TOKEN",
    "cp env:FOO env:GH_TOKEN",
    "copy env:FOO env:GH_TOKEN",
    "Copy-Item x env:GH_TOKEN",
    "[Environment]::SetEnvironmentVariable($n,'x')",
    '[Environment]::SetEnvironmentVariable("X$n",\'x\')',
    "[Environment]::SetEnvironmentVariable((Get-Content f),'x')",
    "$e=[Environment]; $e::SetEnvironmentVariable($n,'x')",
    "[Environment]::SetEnvironmentVariable()",
    "if ($c) { . ./f.ps1 }",
    "& { Remove-Item env:* }",
  ]);

  it("a dot-sourced call is still read, and a path that isn't env: passes", async () => {
    expect((await hook(`. gh pr list`, PS, { GH_TOKEN: WRONG })).decision).toBe("deny");
    expect((await hook(`. gh pr list`, PS, { GH_TOKEN: RIGHT })).decision).toBe("allow");
    expect((await hook(`Remove-Item $f; ${CALL}`, PS)).decision).toBe("allow");
    expect((await hook(`Set-Content $f 'x'; ${CALL}`, PS)).decision).toBe("allow");
    expect((await hook(`Set-Content x.yml 'env: prod'; ${CALL}`, PS)).decision).toBe("allow");
    expect((await hook(`Set-Content x.yml "env:$y"; ${CALL}`, PS)).decision).toBe("allow");
    expect((await hook(`Remove-Item x.txt, y.txt; ${CALL}`, PS)).decision).toBe("allow");
    expect((await hook(`Copy-Item a.txt b.txt; ${CALL}`, PS)).decision).toBe("allow");
    expect((await hook(`'.' ; ${CALL}`, PS)).decision).toBe("allow");
  });

  it("a known name still says which", async () => {
    const stopped = await hook(`if ($c) { $env:GH_TOKEN='x' }; ${CALL}`, PS);
    expect(stopped.reason).toContain(NAMED);
    expect(stopped.reason).toContain("inside a block");
  });
});
