import { describe, expect, it } from "vitest";
import { findInvocations } from "../src/shellwords.js";
import { calls, hook, type Shell, WRONG_TOKEN } from "./hook-line-env-fixture.js";

// cmd.exe's `set NAME=value` reaches the commands after it on the line. Checked against real cmd.exe from Git Bash and
// Windows PowerShell 5.1 with a printer, and `set /?`.
const CALL = "gh pr list";

describe("cmd /c: set before a call", () => {
  it.each<[Shell, string]>([
    ["Bash", `cmd /c "set GH_TOKEN=${WRONG_TOKEN}&& ${CALL}"`],
    ["Bash", `cmd /c "set GH_TOKEN=${WRONG_TOKEN}& ${CALL}"`],
    ["Bash", `cmd /c "set GH_TOKEN=${WRONG_TOKEN}&& echo hi && ${CALL}"`],
    ["Bash", `cmd /c "set "GH_TOKEN=${WRONG_TOKEN}"&& ${CALL}"`],
    ["PowerShell", `cmd /c "set GH_TOKEN=${WRONG_TOKEN}&& ${CALL}"`],
    ["PowerShell", `cmd /c 'set GH_TOKEN=${WRONG_TOKEN}&& ${CALL}'`],
    ["PowerShell", `cmd /c "SET GH_TOKEN=${WRONG_TOKEN}&& ${CALL}"`],
  ])("%s: %s reaches the lookup, so the wrong account denies", async (tool, line) => {
    const answer = await hook(line, { tool, platform: "win32" });
    expect(answer.decision).toBe("deny");
    expect(answer.reason).toContain("someone-else");
    expect(calls).toHaveLength(1);
  });

  it("the words a set takes are its value, spaces included", () => {
    expect(findInvocations(`cmd /c "set FOO=a b&& gh pr list"`, ["gh"], undefined, undefined, "powershell")[0]!.env).toEqual({ FOO: "a b" });
    expect(findInvocations(`cmd /c "set FOO=&& gh pr list"`, ["gh"], undefined, undefined, "powershell")[0]!.env).toEqual({ FOO: "" });
  });

  it("a variable that can run code stops, starting nothing", async () => {
    for (const line of [`cmd /c "set NODE_OPTIONS=--require=x&& ${CALL}"`, `cmd /c "set node_options=--require=x&& ${CALL}"`]) {
      const stopped = await hook(line, { platform: "win32" });
      expect(stopped.decision).toBe("deny");
      expect(stopped.reason).toContain("NODE_OPTIONS");
      expect(calls).toEqual([]);
    }
  });

  it("a set after the call doesn't reach it", async () => {
    expect((await hook(`cmd /c "${CALL}&& set GH_TOKEN=${WRONG_TOKEN}"`, { platform: "win32" })).decision).toBe("allow");
    expect(calls).toHaveLength(1);
  });

  it("a name that is no identifier is one to cmd.exe too", () => {
    expect(findInvocations(`cmd /c "set A.B=1&& gh pr list"`, ["gh"], undefined, undefined, "powershell")[0]!.env).toEqual({ "A.B": "1" });
  });

  it.each([
    `cmd /c "set /p GH_TOKEN=x&& ${CALL}"`,
    `cmd /c "set /a X=1&& ${CALL}"`,
  ])("%s: can't tell", async (line) => {
    const stopped = await hook(line, { platform: "win32" });
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain("could not tell");
    expect(calls).toEqual([]);
  });

  it("a set in quotes, which cmd.exe takes off", async () => {
    expect(findInvocations(`cmd /c 'set "FOO=a b"&& gh pr list'`, ["gh"], undefined, undefined, "powershell")[0]!.env).toEqual({ FOO: "a b" });
    expect((await hook(`cmd /c 'set "GH_TOKEN=${WRONG_TOKEN}"&& ${CALL}'`, { tool: "PowerShell", platform: "win32" })).reason).toContain("someone-else");
  });

  it("a set that only prints changes nothing, and neither does a line with no call", async () => {
    expect((await hook(`cmd /c "set&& ${CALL}"`, { platform: "win32" })).decision).toBe("allow");
    expect(calls).toHaveLength(1);
    expect((await hook(`cmd /c "set GH&& ${CALL}"`, { platform: "win32" })).decision).toBe("allow");
    expect(calls).toHaveLength(1);
    expect((await hook(`cmd /c "set GH_TOKEN=${WRONG_TOKEN}&& dir"`, { platform: "win32" })).decision).toBe("allow");
    expect(calls).toEqual([]);
  });
});
