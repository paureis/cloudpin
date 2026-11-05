import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findInvocations } from "../src/shellwords.js";
import { CALL, CANT_TELL, followed, hook, refused, root, SUB_PIN } from "./hook-folder-fixture.js";

describe("PowerShell: every spelling that can be read is followed, in any case (#163)", () => {
  followed("PowerShell", [
    "cd DIR",
    "CD DIR",
    "chdir DIR",
    "ChDir DIR",
    "sl DIR",
    "SL DIR",
    "Set-Location DIR",
    "set-location DIR",
    "SET-LOCATION DIR",
    "Microsoft.PowerShell.Management\\Set-Location DIR",
    "pushd DIR",
    "PUSHD DIR",
    "Push-Location DIR",
    "push-location DIR",
    "cd -Path DIR",
    "cd -path DIR",
    "cd -PATH DIR",
    "cd -Pat DIR",
    "cd -Path:DIR",
    "cd -LiteralPath DIR",
    "cd -literalpath DIR",
    "cd -L DIR",
    "cd -Lit DIR",
    "cd -PSPath DIR",
    "cd -PS DIR",
    "cd -LiteralPath:DIR",
    "cd -- DIR",
    "Set-Location -Path DIR -PassThru",
    "Set-Location DIR -PassThru",
    "Set-Location -PassThru DIR",
    "Set-Location -Pas DIR",
    "Set-Location -ErrorAction Stop DIR",
    "Set-Location -ea SilentlyContinue DIR",
    "Set-Location -Path DIR -ea Stop",
    "Set-Location -Verbose DIR",
    "Set-Location -Verb DIR",
    "Set-Location -vb DIR",
    "Push-Location -Path DIR",
    "Push-Location -LiteralPath DIR",
    "Push-Location DIR -PassThru",
    "$d='DIR'; cd $d",
    "$D='DIR'; cd $d",
    "$d='DIR'; cd \"$d\"",
    "$d='DIR'; Set-Location -Path $d",
    "$d='DIR'; Set-Location -Path:$d",
    "$env:DD='DIR'; cd $env:DD",
    "cd $PWD/DIR",
    'cd "$PWD/DIR"',
    "iex 'cd DIR'",
    "Invoke-Expression 'cd DIR'",
    "'cd DIR' | iex",
    "$x = cd DIR",
    "cd DIR | Out-Null",
    "Push-Location sub; Push-Location ../DIR; Push-Location ../other; Pop-Location",
    "Push-Location sub; Push-Location ../DIR; Push-Location ../other; popd",
    "cd sub; cd ../DIR",
  ]);

  it("follows $env:NAME from the hook's environment, in any case, but not a bare $NAME", async () => {
    expect((await hook(`cd $env:HOOK_DIR; ${CALL}`, "PowerShell", { HOOK_DIR: "sub" })).decision).toBe("deny");
    expect((await hook(`cd $env:hook_dir; ${CALL}`, "PowerShell", { HOOK_DIR: "other" })).decision).toBe("allow");
    expect((await hook(`cd $HOOK_DIR; ${CALL}`, "PowerShell", { HOOK_DIR: "other" })).reason).toContain(CANT_TELL);
    expect((await hook(`cd $xxxxHOOK_DIR; ${CALL}`, "PowerShell", { HOOK_DIR: "other" })).reason).toContain(CANT_TELL);
    expect((await hook(`$env:HOOK_DIR=(Get-Item x); cd $env:HOOK_DIR; ${CALL}`, "PowerShell", { HOOK_DIR: "other" })).reason).toContain(CANT_TELL);
  });

  it("goes back with Pop-Location to a folder the line knows", async () => {
    expect((await hook(`Push-Location sub; Pop-Location; ${CALL}`, "PowerShell")).decision).toBe("allow");
    expect((await hook(`Push-Location sub; Push-Location ../other; Pop-Location -PassThru; ${CALL}`, "PowerShell")).decision).toBe("deny");
  });

  it("-LiteralPath takes a wildcard as text, -Path doesn't", async () => {
    mkdirSync(join(root, "sub", "[id]"), { recursive: true });
    expect((await hook(`cd -LiteralPath 'sub/[id]'; ${CALL}`, "PowerShell")).reason).toContain(SUB_PIN);
    expect((await hook(`cd -Path 'sub/[id]'; ${CALL}`, "PowerShell")).reason).toContain(CANT_TELL);
  });

  it("~ and $HOME are home, even ~ in quotes, as Set-Location reads it", async () => {
    const cwdOf = (line: string) => findInvocations(`${line}; gh a`, ["gh"], root, {}, "powershell")[0]?.cwd;
    for (const line of ["cd ~", "cd '~'", 'cd "~"', "cd $HOME"]) expect(cwdOf(line), line).toBe(homedir());
    expect(cwdOf("cd ~/x")).toBe(join(homedir(), "x"));
  });

  it("a parameter 5.1 rejects leaves the folder where it was", async () => {
    for (const line of ["cd -P sub", "cd -Pa sub", "cd -Foo sub", "Set-Location -W x sub", "Set-Location -Path", "Pop-Location -Foo"]) {
      expect((await hook(`${line}; ${CALL}`, "PowerShell")).decision, line).toBe("allow");
    }
  });

  it("a child PowerShell keeps its folder to itself, its own line still read", async () => {
    expect((await hook(`powershell -c 'cd sub'; ${CALL}`, "PowerShell")).decision).toBe("allow");
    expect((await hook(`powershell -c 'cd sub; ${CALL}'`, "PowerShell")).reason).toContain(SUB_PIN);
  });

  it("a block sees the folder it moved to; with no move, what follows it is known", async () => {
    expect((await hook(`& { cd sub; ${CALL} }`, "PowerShell")).reason).toContain(SUB_PIN);
    expect((await hook(`& { cd other; ${CALL} }`, "PowerShell")).decision).toBe("allow");
    expect((await hook(`& { ${CALL} }; ${CALL}`, "PowerShell")).decision).toBe("allow");
  });
});

describe("PowerShell: what can't be read stops later calls as can't tell (#163)", () => {
  refused("PowerShell", [
    "cd (Get-Item x)",
    "cd $(Get-Location)",
    "cd $nope",
    'cd "$nope/sub"',
    "cd $nope.Path",
    "cd",
    "Set-Location",
    "Push-Location",
    "cd -",
    "cd +",
    "cd ''",
    "cd su*",
    "cd 'su*'",
    "cd s?b",
    "cd 's[u]b'",
    "cd sub other",
    "cd sub -Path other",
    "'sub' | cd",
    "$d | Set-Location",
    "Set-Location -StackName x",
    "Set-Location -S x",
    // 5.1 has no -LP, and stays; 7 does, and moves.
    "cd -LP sub",
    "Push-Location -StackName x sub",
    "Pop-Location",
    "popd",
    "Pop-Location -StackName x",
    "cd Env:",
    "cd HKCU:\\",
    "cd Function:",
    "cd C:",
    "cd C:sub",
    "cd FileSystem::C:\\x",
    "cd Microsoft.PowerShell.Core\\FileSystem::C:\\x",
    // A variable may be anything, here a value the parameter rejects.
    "Set-Location -ea $x sub",
    "Push-Location sub; & { Push-Location . }; Pop-Location",
    "& { cd sub }",
    ". { cd sub }",
    "if ($x) { cd sub }",
    "try { cd sub } catch { }",
    "1 | ForEach-Object { cd sub }",
    "(cd sub)",
    "$(cd sub)",
    "@(cd sub)",
    "$x = (cd sub)",
    "Push-Location sub; & { Pop-Location }",
  ]);

  it("a folder Start-Process runs in, only known when it runs", async () => {
    const start = "Start-Process az -ArgumentList 'group','list' -WorkingDirectory";
    expect((await hook(`${start} $d`, "PowerShell")).reason).toContain(CANT_TELL);
    expect((await hook(`${start} other`, "PowerShell")).decision).toBe("allow");
    expect((await hook(`${start} sub`, "PowerShell")).reason).toContain(SUB_PIN);
  });
});
