import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cachedExec } from "../src/cache.js";
import { cmdWouldAct, realExec, runInherited } from "../src/exec.js";
import { tempDir } from "./tmp.js";

// cross-spawn sends a .cmd or .bat through cmd.exe, and its escaping does not survive every reading of that line. Each
// expectation here was measured on Windows with printers shaped like the real az.cmd (an IF ( ) block) and npm's cmd-shim.

const AZ = "C:\\bin\\az.cmd";
const win = (args: string[], env: NodeJS.ProcessEnv = {}, file = AZ) => cmdWouldAct(file, args, env, "win32");

describe("cmdWouldAct on Windows", () => {
  describe("a double quote flips what cmd.exe treats as quoted", () => {
    it.each(["&", "|", "<", ">", "^", ")"])("refuses %s left outside the quotes", (c) => {
      expect(win([`a"${c}b`])).toContain(c);
    });

    it("refuses a value wrapped in quotes around a special character", () => {
      expect(win(['"a&b"'])).toContain("&");
      expect(win(['{"a":"b&c"}'])).toContain("&");
    });

    it("counts the quotes of the words before", () => {
      expect(win(['a"b', "x&y"])).toContain("&");
      expect(win(['a"b', "x)y"])).toContain(")");
      expect(win(['a"b', 'c"&d'])).toBeUndefined();
    });

    it("refuses an odd count and passes an even one", () => {
      expect(win(['a"b"c"&d'])).toContain("&");
      expect(win(['a"b"&d'])).toBeUndefined();
      expect(win(['a""&d'])).toBeUndefined();
    });

    it("sees the character at the end of a word", () => {
      expect(win(['a"^'])).toContain("^");
      expect(win(['"&'])).toContain("&");
    });
  });

  describe("values that arrive intact stay allowed", () => {
    it.each([
      "plain",
      "a b",
      "x&y",
      "x|y",
      "x<y",
      "x>y",
      "x^y",
      "(a)",
      "a)b",
      "%ZZP%",
      "!ZZP!",
      "100%",
      "a%20b%20c",
      "%H:%M",
      "%Y-%m-%d %H:%M:%S",
      '"',
      'a"b',
      '""',
      '"a"',
      'a"(b',
      'a"%ZZP%b',
      'a"!ZZP!b',
      'a" b',
      'a" --subscription other',
      'a";b',
      'a",b',
      'a"=b',
      'a"*b',
      'a"?b',
      'a"\tb',
      '\\"',
      'a\\"b',
      "a\\",
      "a b\\",
      "a\\\\b",
      "\\\\server\\share\\",
      'a"\\',
      "x\ty",
    ])("passes %j", (value) => {
      expect(win([value])).toBeUndefined();
    });

    it.each([
      '[].{"Name":name}',
      '[?name=="x y"]',
      '[?a=="b"] | [0]',
      '[?contains(name, "x")].id',
      '[?a=="x"].{"A":a, "B":b}',
      '[?a==`"x"`]',
      '{"a":1}',
      '{"a":"b c"}',
      'value(date.date("%Y-%m-%d %H:%M"))',
    ])("passes the query %j", (value) => {
      expect(win(["--query", value, "--subscription", "x&y"])).toBeUndefined();
    });
  });

  describe("a line break", () => {
    it.each(["x\ny", "x\ry", "x\r\ny", "\n", "\r", 'a"\ny'])("refuses %j", (value) => {
      expect(win([value, "--subscription", "pinned"])).toContain("line break");
    });
  });

  describe("cross-spawn's escaping of a run of backslashes", () => {
    it.each(["a\\\\", "a\\\\\\", "a\\\\\\\\", "C:\\dir\\\\", 'a\\\\"b', 'a\\\\\\"b', 'a\\\\"'])("refuses %j", (value) => {
      expect(win([value, "--subscription", "pinned"])).toContain("backslashes");
    });
  });

  describe("what cmd.exe expands before cross-spawn's escaping counts", () => {
    it.each(["%ZZA:y=z%", "%zza:y=z%", "%ZZA:*y=z%", "%ZZA:y=%", "%ZZA:=%", "%%ZZA:y=z%", "%ZZA:y=z%%", "a%CD:y=z%b", 'a"%ZZA:y=z%'])("refuses the replace form %j", (value) => {
      expect(win([value])).toContain("%NAME:");
    });

    it("refuses the replace form across words", () => {
      expect(win(["%ZZA:y", "=z%"])).toContain("%NAME:");
      expect(win(["%ZZA:y=", "z%"])).toContain("%NAME:");
      expect(win(["%ZZA:", "y=z%"])).toContain("%NAME:");
    });

    it("refuses the replace form begun in the file's own path", () => {
      expect(win(["z%"], {}, "C:\\a%ZZA:y=\\az.cmd")).toContain("%NAME:");
    });

    it.each(["%ZZA:y%", "%ZZA:~1%", "%ZZA:~0,1%", "%ZZA:~-1%", "%ZZA:~%", "%ZZA:", "%ZZA", "ZZA%", "ZZA:y=z%", "%ZZA:y=z"])("passes %j, left literal", (value) => {
      expect(win([value])).toBeUndefined();
    });

    it("refuses %NAME% only when a variable's name ends in a caret", () => {
      expect(win(["%ZZC%"])).toBeUndefined();
      expect(win(["%ZZC%"], { "ZZC^": "x" })).toContain("%NAME%");
      expect(win(["%ZZC%"], { "ZZC^^^": "x" })).toContain("%NAME%");
      expect(win(['a"%ZZC%'], { "ZZC^": "x" })).toContain("%NAME%");
      expect(win(["%ZZC%"], { "ZZ^C": "x" })).toBeUndefined();
      expect(win(["100%"], { "ZZC^": "x" })).toBeUndefined();
      expect(win(["plain"], { "ZZC^": "x" })).toBeUndefined();
    });
  });

  describe("the variables npm's cmd-shim expands without quotes", () => {
    it.each(["&", "|", "<", ">", "^", '"', "\n", "\r"])("refuses %j in COMSPEC and in PATHEXT, in any spelling", (c) => {
      expect(win(["plain"], { COMSPEC: `x${c}y` })).toContain("COMSPEC");
      expect(win(["plain"], { ComSpec: `x${c}y` })).toContain("COMSPEC");
      expect(win(["plain"], { PATHEXT: `.CMD;.Z${c}y` })).toContain("PATHEXT");
      expect(win(["plain"], { PathExt: `.CMD;.Z${c}y` })).toContain("PATHEXT");
    });

    it("passes the usual values, and a folder with parentheses", () => {
      const env = { ComSpec: "C:\\Program Files (x86)\\tcc.exe", PATHEXT: ".COM;.EXE;.BAT;.CMD;.PY;.PYW;.JS" };
      expect(win(["plain"], env)).toBeUndefined();
    });

    it("looks at no other variable, since a machine's own can hold anything", () => {
      const env = { PATH: "C:\\R&D;C:\\a^b", Other: 'x"&y', PROMPT: "$P$G&" };
      expect(win(["plain"], env)).toBeUndefined();
    });
  });

  describe("which files go through cmd.exe", () => {
    const quoted = ['a"&b'];

    it.each(["C:\\bin\\az.cmd", "C:\\bin\\AZ.CMD", "C:\\bin\\az.bat", "C:\\bin\\az", "C:/bin/az", "C:\\bin\\az.ps1", "C:\\bin\\az.exe.cmd"])("%s does", (file) => {
      expect(win(quoted, {}, file)).toBeDefined();
    });

    it.each(["C:\\bin\\gh.exe", "C:\\bin\\GH.EXE", "C:\\bin\\x.com", "C:\\bin\\X.COM"])("%s does not", (file) => {
      expect(win(quoted, {}, file)).toBeUndefined();
      expect(win(["x\ny"], {}, file)).toBeUndefined();
      expect(win(["a\\\\"], {}, file)).toBeUndefined();
      expect(win(["%ZZA:y=z%"], {}, file)).toBeUndefined();
      expect(win(["plain"], { COMSPEC: "x&y" }, file)).toBeUndefined();
    });
  });

  it("names the kind of character and never the value", () => {
    const value = 'SECRETVALUE"&SECRETCOMMAND';
    const said = win([value])!;
    expect(said).not.toContain("SECRET");
    const fromEnv = win(["plain"], { COMSPEC: "SECRETVALUE&SECRETCOMMAND" })!;
    expect(fromEnv).not.toContain("SECRET");
  });
});

describe("cmdWouldAct on Linux and macOS", () => {
  it.each(["linux", "darwin"] as const)("%s has no cmd.exe, whatever the file is called", (platform) => {
    for (const file of ["/usr/bin/az.cmd", "/usr/bin/az.bat", "/usr/bin/az"]) {
      for (const args of [['a"&b'], ["x\ny"], ["a\\\\"], ["%ZZA:y=z%"]]) {
        expect(cmdWouldAct(file, args, { COMSPEC: "x&y", "ZZC^": "x" }, platform)).toBeUndefined();
      }
    }
  });
});

const isWindows = process.platform === "win32";
const SELF = "zzcmdprinter";
const NPM = "zznpmprinter";
const OTHER = "zzothercommand";

/** Printers in a temporary folder, on no PATH but their own: nothing else can answer to these names. */
function printers() {
  const dir = tempDir("cloudpin-cmd-quote-");
  const log = join(dir, "print.log");
  const script = join(dir, "print.cjs");
  writeFileSync(
    script,
    [
      'const fs = require("node:fs");',
      "const [, , name, ...args] = process.argv;",
      'fs.appendFileSync(process.env.PRINT_LOG, JSON.stringify({ name, args }) + "\\n");',
      "",
    ].join("\n"),
  );
  const node = process.execPath;
  const crlf = (lines: string[]) => lines.join("\r\n") + "\r\n";
  if (isWindows) {
    // The shape of the real az.cmd: setlocal, then the program inside IF ( ).
    writeFileSync(
      join(dir, `${SELF}.cmd`),
      crlf(["@echo off", "setlocal", `IF EXIST "${node}" (`, `  "${node}" "${script}" ${SELF} %*`, ") ELSE (", "  exit /b 1", ")", "endlocal"]),
    );
    // The shape of npm's cmd-shim.
    writeFileSync(
      join(dir, `${NPM}.cmd`),
      crlf([
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        `  SET "_prog=${node}"`,
        "  SET PATHEXT=%PATHEXT:;.JS;=;%",
        ")",
        `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "${script}" ${NPM} %*`,
      ]),
    );
    writeFileSync(join(dir, `${OTHER}.cmd`), crlf(["@echo off", `"${node}" "${script}" ${OTHER} %*`]));
  }
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!["PATH", "NODEFAULTCURRENTDIRECTORYINEXEPATH", "COMSPEC", "PATHEXT"].includes(k.toUpperCase())) out[k] = v;
    }
    return { ...out, PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: process.env.ComSpec, PRINT_LOG: log, ...extra };
  };
  const printed = () =>
    (existsSync(log) ? readFileSync(log, "utf8") : "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { name: string; args: string[] });
  return { dir, script, env, printed, clear: () => writeFileSync(log, "") };
}

describe.runIf(isWindows)("spawning on Windows, with printers", () => {
  const refused: [string, string[], NodeJS.ProcessEnv?][] = [
    ["a quote then &", ['a"&' + OTHER]],
    ["a quote then |", ['a"|' + OTHER]],
    ["a quote then >", ['a">outfile']],
    ["a quote in the word before", ['a"b', "x&" + OTHER]],
    ["a newline before the pinned flag", ["x\ny", "--subscription", "pinned"]],
    ["two backslashes before the pinned flag", ["a\\\\", "--subscription", "pinned"]],
    ["the replace form", [`%ZZA:y=z%`], { ZZA: "x&" + OTHER }],
    ["a variable ending in a caret", ["%ZZC%"], { "ZZC^": "x&" + OTHER }],
    ["COMSPEC", ["plain"], { COMSPEC: "x&" + OTHER }],
    ["PATHEXT", ["plain"], { PATHEXT: `.COM;.EXE;.BAT;.CMD;.Z&${OTHER}` }],
  ];
  const intact: string[][] = [
    ["plain"],
    ["a b"],
    ["x&" + OTHER],
    ["x^y"],
    ["(a)"],
    ["%ZZP%"],
    ['a"b'],
    ['a" --subscription other'],
    ['a"b', "--subscription", "pinned"],
    ['a"%ZZP%b'],
    ['[].{"Name":name}'],
    ['[?name=="x y"]'],
    ['[?a=="b"] | [0]'],
    ['[?contains(name, "x")].id'],
    ["a\\"],
    ["C:\\dir\\", "--subscription", "pinned"],
  ];

  describe.each([SELF, NPM])("%s", (name) => {
    it.each(refused)("realExec refuses %s, runs nothing, and says why", async (_label, args, extra) => {
      const p = printers();
      const cwd = process.cwd();
      process.chdir(p.dir);
      try {
        const res = await realExec(name, args, p.env(extra));
        expect(p.printed()).toEqual([]);
        expect(res.code).not.toBe(0);
        expect(res.notFound).toBeFalsy();
        expect(res.stdout).toBe("");
        expect(res.stderr).toContain("cmd.exe");
        for (const a of args) if (a.length > 3 && a !== "--subscription" && a !== "pinned") expect(res.stderr).not.toContain(a);
        expect(existsSync(join(p.dir, "outfile"))).toBe(false);
      } finally {
        process.chdir(cwd);
      }
    });

    it.each(refused)("runInherited refuses %s, runs nothing, and exits non-zero", async (_label, args, extra) => {
      const p = printers();
      const cwd = process.cwd();
      process.chdir(p.dir);
      const errors: string[] = [];
      const before = console.error;
      console.error = (line: string) => void errors.push(line);
      try {
        const code = await runInherited(name, args, p.env(extra), "ignore");
        expect(p.printed()).toEqual([]);
        expect(code).toBe(127);
        expect(errors.join("\n")).toContain("cmd.exe");
        for (const a of args) if (a.length > 3 && a !== "--subscription" && a !== "pinned") expect(errors.join("\n")).not.toContain(a);
        expect(existsSync(join(p.dir, "outfile"))).toBe(false);
      } finally {
        console.error = before;
        process.chdir(cwd);
      }
    });

    it.each(intact.map((args) => [JSON.stringify(args), args] as const))("passes %s through both, argv intact", async (_label, args) => {
      const p = printers();
      const res = await realExec(name, args, p.env());
      expect(res.code).toBe(0);
      expect(p.printed()).toEqual([{ name, args }]);
      p.clear();
      expect(await runInherited(name, args, p.env(), "ignore")).toBe(0);
      expect(p.printed()).toEqual([{ name, args }]);
    });
  });

  it("a real .exe gets every value as it is, with no cmd.exe to read it", async () => {
    const p = printers();
    for (const args of [['a"&' + OTHER], ["x\ny", "--subscription", "pinned"], ["a\\\\", "--subscription", "pinned"], ["%ZZA:y=z%"]]) {
      p.clear();
      // process.execPath is node.exe: the absolute path of a real executable.
      const res = await realExec(process.execPath, [p.script, SELF, ...args], p.env({ ZZA: "x&" + OTHER }));
      expect(res.code).toBe(0);
      expect(p.printed()).toEqual([{ name: SELF, args }]);
    }
  });

  it("a refusal is never cached: the next try asks again", async () => {
    const p = printers();
    const cacheDir = join(p.dir, "cache");
    const inputs = { env: [], files: [], dirs: [] };
    const exec = cachedExec(realExec, inputs, { cacheDir, env: {} });
    const value = ['a"&' + OTHER];
    const first = await exec(SELF, value, p.env());
    const second = await exec(SELF, value, p.env());
    expect(first.code).not.toBe(0);
    expect(second.code).not.toBe(0);
    expect(p.printed()).toEqual([]);
    expect(existsSync(join(cacheDir, "identity-cache.json"))).toBe(false);
  });
});

describe.skipIf(isWindows)("spawning on Linux and macOS", () => {
  it("runs a script named .cmd with every value as it is", async () => {
    const p = printers();
    const file = join(p.dir, `${SELF}.cmd`);
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${p.script}" ${SELF} "$@"\n`);
    chmodSync(file, 0o755);
    const args = ['a"&b', "x\ny", "a\\\\", "%ZZA:y=z%"];
    const res = await realExec(`${SELF}.cmd`, args, p.env({ COMSPEC: "x&y" }));
    expect(res.code).toBe(0);
    expect(p.printed()).toEqual([{ name: SELF, args }]);
    p.clear();
    expect(await runInherited(`${SELF}.cmd`, args, p.env({ COMSPEC: "x&y" }), "ignore")).toBe(0);
    expect(p.printed()).toEqual([{ name: SELF, args }]);
  });
});
