import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { explain } from "../src/explain.js";
import { defaultFindConfig, guard, type GuardDeps } from "../src/guard.js";
import { AGENTS, runHook } from "../src/hooks/agents.js";
import { cloudpinTools } from "../src/mcp-tools.js";
import { type Exec, UNKNOWN_FOLDER } from "../src/types.js";
import { azure } from "../src/providers/azure.js";
import { fakeDoctorHost } from "./fake-doctor-host.js";
import { CANT_TELL, PINNED } from "./hook-folder-fixture.js";
import { tempDir } from "./tmp.js";

// #163, owner's decision: an unknown folder stops a call only when a pin file is in sight from the last folder the
// line knew, by findConfig's own upward search. With none in sight cloudpin does nothing (DESIGN.md, "No .cloudpin.yml
// found"). The active subscription is PINNED; a pin file with OTHER denies a call read as running under it.

const OTHER = "22222222-0000-0000-0000-000000000002";
const CALL = "az group list";
const LOST = 'cd "$(cat f)"';
const asked: string[][] = [];
const exec: Exec = async (bin, args) => {
  asked.push([bin, ...args]);
  return { code: 0, stdout: JSON.stringify({ id: PINNED, tenantId: PINNED, name: "x" }), stderr: "" };
};
const deps: GuardDeps = { providers: [azure], exec, findConfig: defaultFindConfig };

const folder = (name: string) => realpathSync(tempDir(`cloudpin-163-sight-${name}-`));
const pin = (dir: string, subscription: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".cloudpin.yml"), `azure:\n  subscription: ${subscription}\n`);
};
const quote = (path: string) => JSON.stringify(path);

async function hook(command: string, cwd: string, tool = "Bash", d: GuardDeps = deps): Promise<{ decision: string; reason: string }> {
  const out = await runHook(AGENTS.claude, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: { command }, cwd }), d, {}, undefined, "linux");
  if (!out) return { decision: "allow", reason: "" };
  const { permissionDecision, permissionDecisionReason } = JSON.parse(out).hookSpecificOutput;
  return { decision: permissionDecision, reason: permissionDecisionReason };
}

/** A folder with no pin file at or above it, holding `sub` with its own and `plain` with none. */
function unpinned() {
  const start = folder("bare");
  pin(join(start, "sub"), OTHER);
  mkdirSync(join(start, "plain"));
  return { start, sub: join(start, "sub"), plain: join(start, "plain") };
}

describe("where the search starts when the folder is unknown (#163)", () => {
  it("a pin file in the starting folder stops", async () => {
    const start = folder("pinned");
    pin(start, PINNED);
    expect((await hook(`${LOST}; ${CALL}`, start)).reason).toContain(CANT_TELL);
  });

  it("a pin file in a parent of the starting folder stops", async () => {
    const top = folder("parent");
    pin(top, PINNED);
    const start = join(top, "a", "b");
    mkdirSync(start, { recursive: true });
    expect((await hook(`${LOST}; ${CALL}`, start)).reason).toContain(CANT_TELL);
  });

  it("no pin file anywhere passes, and asks no CLI", async () => {
    const { start } = unpinned();
    asked.length = 0;
    expect((await hook(`${LOST}; ${CALL}`, start)).decision).toBe("allow");
    expect(asked).toEqual([]);
  });

  it("control: no pin at the start, a literal cd still reads the pin file it reaches", async () => {
    const { start } = unpinned();
    expect((await hook(`cd sub; ${CALL}`, start)).reason).toContain(join(start, "sub", ".cloudpin.yml"));
    expect((await hook(`cd plain; ${CALL}`, start)).decision).toBe("allow");
    expect((await hook(CALL, start)).decision).toBe("allow");
  });

  it("a known folder and then an unknown one searches from the known one", async () => {
    const { start, sub, plain } = unpinned();
    expect((await hook(`cd sub; ${LOST}; ${CALL}`, start)).reason).toContain(CANT_TELL);
    expect((await hook(`cd plain; ${LOST}; ${CALL}`, start)).decision).toBe("allow");
    // The other way round: from a pinned start to a folder with no pin in sight.
    const pinned = folder("pinned-start");
    pin(pinned, PINNED);
    expect((await hook(`cd ${quote(plain)}; ${LOST}; ${CALL}`, pinned)).decision).toBe("allow");
    expect((await hook(`cd ${quote(sub)}; ${LOST}; ${CALL}`, pinned)).reason).toContain(CANT_TELL);
  });

  it("the last folder known is the one before it was lost, whatever follows", async () => {
    const { start, sub, plain } = unpinned();
    // Lost, then relative: still unknown, still from where it was lost.
    expect((await hook(`${LOST}; cd sub; ${CALL}`, start)).decision).toBe("allow");
    expect((await hook(`cd sub; ${LOST}; cd ../plain; ${CALL}`, start)).reason).toContain(CANT_TELL);
    // Known again, and lost again: from the newer one.
    expect((await hook(`cd sub; ${LOST}; cd ${quote(plain)}; ${LOST}; ${CALL}`, start)).decision).toBe("allow");
    expect((await hook(`cd plain; ${LOST}; cd ${quote(sub)}; ${LOST}; ${CALL}`, start)).reason).toContain(CANT_TELL);
    // Back to the unknown folder on the stack: from the newest it knew.
    expect((await hook(`${LOST}; pushd ${quote(sub)}; popd; ${CALL}`, start)).reason).toContain(CANT_TELL);
  });

  it("a subshell's or a job's last folder doesn't come back", async () => {
    const { start, sub } = unpinned();
    expect((await hook(`(cd sub; ${LOST}; ${CALL})`, start)).reason).toContain(CANT_TELL);
    expect((await hook(`${LOST}; (cd ${quote(sub)}; ${LOST}); ${CALL}`, start)).decision).toBe("allow");
    expect((await hook(`${LOST}; cd ${quote(sub)} | cat; ${CALL}`, start)).decision).toBe("allow");
  });

  it("a wrapper's unknown folder searches from where the wrapper runs", async () => {
    const { start } = unpinned();
    expect((await hook(`env -C "$D" ${CALL}`, start)).decision).toBe("allow");
    expect((await hook(`cd sub; env -C "$D" ${CALL}`, start)).reason).toContain(CANT_TELL);
  });

  it("the same in PowerShell", async () => {
    const { start } = unpinned();
    expect((await hook(`Set-Location (Get-Item x); ${CALL}`, start, "PowerShell")).decision).toBe("allow");
    expect((await hook(`Set-Location sub; Set-Location (Get-Item x); ${CALL}`, start, "PowerShell")).reason).toContain(CANT_TELL);
    expect((await hook(`& { cd sub }; ${CALL}`, start, "PowerShell")).decision).toBe("allow");
    expect((await hook(`cd sub; & { cd .. }; ${CALL}`, start, "PowerShell")).reason).toContain(CANT_TELL);
  });
});

describe("what counts as in sight (#163)", () => {
  it("a pin file that pins something else: the folder it goes to may pin this", async () => {
    const start = folder("gh-only");
    writeFileSync(join(start, ".cloudpin.yml"), "github:\n  user: someone\n");
    expect((await hook(`${LOST}; ${CALL}`, start)).reason).toContain(CANT_TELL);
    expect((await hook(CALL, start)).decision).toBe("allow");
  });

  it("a pin file with nothing in it", async () => {
    const start = folder("empty");
    writeFileSync(join(start, ".cloudpin.yml"), "");
    expect((await hook(`${LOST}; ${CALL}`, start)).reason).toContain(CANT_TELL);
  });

  it.each([
    ["bad YAML", "azure: [\n"],
    ["an unknown section", "azur:\n  subscription: x\n"],
  ])("a pin file it can't read: %s stops, here and in a parent, and an exempt call runs", async (_name, text) => {
    const top = folder("broken");
    writeFileSync(join(top, ".cloudpin.yml"), text);
    const start = join(top, "a");
    mkdirSync(start);
    for (const cwd of [top, start]) {
      expect((await hook(`${LOST}; ${CALL}`, cwd)).reason, cwd).toContain(CANT_TELL);
      expect((await hook(`${LOST}; az version`, cwd)).decision, cwd).toBe("allow");
    }
  });

  it("anything else findConfig can't do blocks, as it does anywhere", async () => {
    const start = folder("eacces");
    const denied: GuardDeps = { ...deps, findConfig: () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); } };
    expect((await hook(`${LOST}; ${CALL}`, start, "Bash", denied)).reason).toContain("could not check");
  });

  it("an exempt call and a line with no guarded call don't search at all", async () => {
    const seen: string[] = [];
    const spy: GuardDeps = { ...deps, findConfig: (cwd, env) => (seen.push(cwd), defaultFindConfig(cwd, env)) };
    const start = folder("spy");
    pin(start, PINNED);
    expect((await hook(`${LOST}; az version`, start, "Bash", spy)).decision).toBe("allow");
    expect((await hook(`${LOST}; ls`, start, "Bash", spy)).decision).toBe("allow");
    expect(seen).toEqual([]);
  });

  it("the search goes to the known folder, and never to the marker", async () => {
    const seen: string[] = [];
    const spy: GuardDeps = { ...deps, findConfig: (cwd, env) => (seen.push(cwd), defaultFindConfig(cwd, env)) };
    const { start, sub } = unpinned();
    await hook(`cd sub; ${LOST}; ${CALL}`, start, "Bash", spy);
    expect(seen).toEqual([sub]);
    expect(seen).not.toContain(UNKNOWN_FOLDER);
  });

  it("guard with no folder to search from stops, and doesn't guess one", async () => {
    let searched = false;
    const spy: GuardDeps = { ...deps, findConfig: () => ((searched = true), null) };
    const verdict = await guard({ bin: "az", args: ["group", "list"], env: {}, cwd: UNKNOWN_FOLDER, mode: "agent" }, spy);
    expect(verdict).toMatchObject({ action: "block", uncertain: true });
    expect(searched).toBe(false);
  });
});

describe("explain, cloudpin_check and cloudpin switch agree (#163)", () => {
  const line = `${LOST}; ${CALL}`;
  const tools = (cwd: string) => cloudpinTools(deps, { cwd, env: {}, read: () => null, isDir: () => true, doctor: fakeDoctorHost }).find((t) => t.name === "cloudpin_check")!;

  it("with no pin file in sight: allow, saying the folder is unknown and why", async () => {
    const { start } = unpinned();
    const [call] = await explain(line, { mode: "agent", cwd: start, env: {} }, deps);
    expect(call).toMatchObject({ verdict: "allow", cwd: UNKNOWN_FOLDER });
    expect(call!.reason).toContain("last folder");
    const result = (await tools(start).call({ command: line })) as { calls: { verdict: string; cwd: string }[] };
    expect(result.calls.map((c) => [c.verdict, c.cwd])).toEqual([["allow", UNKNOWN_FOLDER]]);
  });

  it("with one in sight: block", async () => {
    const start = folder("explain");
    pin(start, PINNED);
    const [call] = await explain(line, { mode: "agent", cwd: start, env: {} }, deps);
    expect(call).toMatchObject({ verdict: "block", cwd: UNKNOWN_FOLDER });
    expect(call!.pinFile).toBeUndefined();
    const result = (await tools(start).call({ command: line })) as { calls: { verdict: string }[] };
    expect(result.calls.map((c) => c.verdict)).toEqual(["block"]);
  });

  it("explain follows a wrapped call's last folder too", async () => {
    const { start } = unpinned();
    const moved = `cd sub; ${LOST}; cloudpin exec -- ${CALL}`;
    expect((await explain(moved, { mode: "agent", cwd: start, env: {} }, deps)).at(-1)?.verdict).toBe("block");
    expect((await explain(`cd plain; ${LOST}; cloudpin exec -- ${CALL}`, { mode: "agent", cwd: start, env: {} }, deps)).at(-1)?.verdict).toBe("allow");
  });

  it("cloudpin switch asks either way, and names no pins", async () => {
    const { start } = unpinned();
    const none = await hook(`${LOST}; cloudpin switch`, start);
    expect(none.decision).toBe("ask");
    expect(none.reason).not.toContain(".cloudpin.yml");
    const sight = await hook(`cd sub; ${LOST}; cloudpin switch`, start);
    expect(sight.decision).toBe("ask");
    expect(sight.reason).not.toContain(OTHER);
  });
});
