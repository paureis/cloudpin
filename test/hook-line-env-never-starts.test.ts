import { beforeEach, describe, expect, it } from "vitest";
import { findOnPath } from "../src/paths.js";
import { calls, hook, type Shell, state } from "./hook-line-env-fixture.js";

// The three shapes the 1.2.3 advisory is about, each with a control that comes out the other way. Exec is fake, so what
// would start is asked of findOnPath with the environment the lookup was given.
beforeEach(() => {
  state.missing = false;
});

const CALL = "gh pr list";

describe("NODE_OPTIONS on the line: no lookup starts", () => {
  it.each<[Shell, string]>([
    ["Bash", `NODE_OPTIONS=--require=./x.js ${CALL}`],
    ["Bash", `NODE_OPTIONS="--import=data:text/javascript,x" ${CALL}`],
    ["Bash", `export NODE_OPTIONS=--require=./x.js; ${CALL}`],
    ["Bash", `env NODE_OPTIONS=--require=./x.js ${CALL}`],
    ["PowerShell", `$env:NODE_OPTIONS='--require=./x.js'; ${CALL}`],
  ])("%s: %s", async (tool, line) => {
    expect((await hook(line, { tool })).decision).toBe("deny");
    expect(calls).toEqual([]);
  });

  it("control: without it the lookup starts", async () => {
    expect((await hook(CALL)).decision).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("control: set before the line started, it is the user's and the lookup starts with it", async () => {
    expect((await hook(CALL, { env: { NODE_OPTIONS: "--no-warnings" } })).decision).toBe("allow");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.NODE_OPTIONS).toBe("--no-warnings");
  });
});

describe("a PATH set on the line that points at a planted file: that file never starts", () => {
  const files = new Set(["/planted/gh", "/hook/bin/gh"]);
  const started = () => findOnPath("gh", calls[0]!.env, "linux", (path) => files.has(path));

  it.each<[Shell, string]>([
    ["Bash", `PATH=/planted ${CALL}`],
    ["Bash", `PATH=/planted; ${CALL}`],
    ["Bash", `export PATH=/planted; ${CALL}`],
    ["Bash", `env PATH=/planted ${CALL}`],
    ["PowerShell", `$env:PATH='/planted'; ${CALL}`],
  ])("%s: %s", async (tool, line) => {
    expect((await hook(line, { tool, env: { PATH: "/hook/bin" } })).decision).toBe("allow");
    expect(calls).toHaveLength(1);
    expect(started()).toBe("/hook/bin/gh");
  });

  it("control: on the PATH the line started with it would start, so this can tell them apart", async () => {
    expect((await hook(CALL, { env: { PATH: "/planted:/hook/bin" } })).decision).toBe("allow");
    expect(started()).toBe("/planted/gh");
  });

  it("on Windows, in any spelling", async () => {
    const windows = new Set(["C:\\planted\\gh.CMD", "C:\\hook\\gh.CMD"]);
    for (const line of [`$env:path='C:\\planted'; ${CALL}`, `$env:Path='C:\\planted'; ${CALL}`, `$env:PATH='C:\\planted'; ${CALL}`]) {
      await hook(line, { tool: "PowerShell", env: { Path: "C:\\hook", PATHEXT: ".CMD" }, platform: "win32" });
      expect(calls).toHaveLength(1);
      expect(findOnPath("gh", calls[0]!.env, "win32", (path) => windows.has(path))).toBe("C:\\hook\\gh.CMD");
    }
  });
});

describe("a PATH built from $PATH: the call is checked, where it used to read as a CLI not installed", () => {
  it.each([
    "PATH=/x:$PATH az group list --subscription other",
    "export PATH=/x:$PATH; az group list --subscription other",
    'export PATH="/x:$PATH"; az group list --subscription other',
  ])("%s: a wrong account denies, after a lookup", async (line) => {
    expect((await hook(line, { env: { PATH: "/hook/bin" } })).decision).toBe("deny");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env.PATH).toBe("/hook/bin");
  });

  it("control: the pinned account passes, after a lookup", async () => {
    expect((await hook("PATH=/x:$PATH az group list", { env: { PATH: "/hook/bin" } })).decision).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("a CLI the lookup can't find can't tell; with PATH left alone it reads as not installed, as a control", async () => {
    state.missing = true;
    expect((await hook("PATH=/x:$PATH az group list", { env: { PATH: "/hook/bin" } })).decision).toBe("deny");
    expect((await hook("az group list", { env: { PATH: "/hook/bin" } })).decision).toBe("allow");
  });
});
