import { describe, expect, it } from "vitest";
import { explain } from "../src/explain.js";
import { cloudpinTools } from "../src/mcp-tools.js";
import { fakeDoctorHost } from "./fake-doctor-host.js";
import { bare, BIN, deps, ENV, hook, pathOf, pinned, resolveTo, RULE, sent, withKube, withVercel } from "./hook-cmd-fixture.js";

describe("with no pin in play nothing stops (#168)", () => {
  const LINE = "az group list --query 'x&y'";
  it("control: pinned", async () => {
    expect((await hook(LINE)).decision).toBe("deny");
  });
  it("no pin file", async () => {
    expect((await hook(LINE, "PowerShell", { cwd: bare })).decision).toBe("allow");
  });
  it("a CLI not pinned", async () => {
    expect((await hook("vercel ls 'x&y'")).decision).toBe("allow");
  });
  it("control: the same CLI pinned", async () => {
    expect((await hook("vercel ls 'x&y'", "PowerShell", { cwd: withVercel })).decision).toBe("deny");
  });
  it.each(["az version 'x&y'", "az login --query 'x&y'", "az --version --query 'a^b'"])("an exempt call: %s", async (command) => {
    expect((await hook(command)).decision).toBe("allow");
  });
  it("a line with no guarded CLI", async () => {
    expect((await hook("ls 'x&kubectl'")).decision).toBe("allow");
  });
});

describe("a guarded CLI named in the text cmd.exe would run (#168)", () => {
  it("stops when that CLI is pinned, though the .cmd CLI is exempt", async () => {
    const { decision, reason } = await hook("az version 'x&kubectl'", "PowerShell", { cwd: withKube });
    expect(decision).toBe("deny");
    expect(reason).toContain(RULE);
  });
  it("control: with a space 5.1 adds quotes, so nothing runs", async () => {
    expect((await hook("az version 'x&kubectl get pods'", "PowerShell", { cwd: withKube })).decision).toBe("allow");
  });
  it("stops when the .cmd CLI isn't pinned", async () => {
    expect((await hook("az group list --query 'x&kubectl'", "PowerShell", { cwd: withKube })).decision).toBe("deny");
  });
  it("passes when nothing named is pinned", async () => {
    expect((await hook("az group list --query 'x&kubectl'", "PowerShell", { cwd: withVercel })).decision).toBe("allow");
  });
  it("an exempt call of it is not a reason", async () => {
    expect((await hook("az version 'x&kubectl version'", "PowerShell", { cwd: withKube })).decision).toBe("allow");
  });
});

describe("the wrapper a CLI runs through may be the .cmd (#168)", () => {
  it("npx.cmd in front of a CLI not on PATH", async () => {
    resolveTo({ vercel: null });
    const { decision, reason } = await hook("npx vercel ls 'x&y'", "PowerShell", { cwd: withVercel });
    expect(decision).toBe("deny");
    expect(reason).toContain(RULE);
  });
  it("control: npx.exe in front of it", async () => {
    resolveTo({ vercel: null, npx: `${BIN}npx.exe` });
    expect((await hook("npx vercel ls 'x&y'", "PowerShell", { cwd: withVercel })).reason).not.toContain(RULE);
  });
  it("cloudpin.cmd in front of the call cloudpin exec reads", async () => {
    const { decision, reason } = await hook("cloudpin exec -- az group list --query 'x&y'");
    expect(decision).toBe("deny");
    expect(reason).toContain(RULE);
  });
  it("control: cloudpin.exe", async () => {
    resolveTo({ cloudpin: `${BIN}cloudpin.exe` });
    expect((await hook("cloudpin exec -- az group list --query 'x&y'")).reason).not.toContain(RULE);
  });
  it("cloudpin.cmd with a guarded CLI after the cut", async () => {
    expect((await hook("cloudpin status 'x&kubectl'", "PowerShell", { cwd: withKube })).decision).toBe("deny");
  });
  it("cloudpin.cmd with none", async () => {
    expect((await hook("cloudpin status 'x&y'")).decision).toBe("allow");
  });
});

describe("where the name resolves, in the call's own environment (#168)", () => {
  const LINE = "az group list --query 'x&y'";
  it("a PATH the line set, to where it is an .exe", async () => {
    expect((await hook(`$env:PATH='C:\\other'; ${LINE}`)).decision).toBe("allow");
  });
  it("in another spelling than the hook's own", async () => {
    expect((await hook(`$env:Path='C:\\other'; ${LINE}`, "PowerShell", { env: { PATH: "C:\\bin" } })).decision).toBe("allow");
    expect((await hook(`$env:PATH='C:\\other'; ${LINE}`, "PowerShell", { env: { Path: "C:\\bin" } })).decision).toBe("allow");
  });
  it("control: the line moves it back to where it is a .cmd", async () => {
    expect((await hook(`$env:PATH='C:\\bin'; ${LINE}`, "PowerShell", { env: { PATH: "C:\\other" } })).decision).toBe("deny");
  });
  it("a PATH the line sets only after the call", async () => {
    expect((await hook(`${LINE}; $env:PATH='C:\\other'`)).decision).toBe("deny");
  });
  it("a PATH cloudpin can't read: it may be a .cmd", async () => {
    const { decision, reason } = await hook(`$env:PATH=$x; ${LINE}`);
    expect(decision).toBe("deny");
    expect(reason).toContain(RULE);
  });
  it("control: that PATH with nothing cmd.exe acts on", async () => {
    expect((await hook("$env:PATH=$x; az group list --query name")).reason).not.toContain(RULE);
  });
  it("not on PATH: nothing runs, so nothing to stop", async () => {
    expect((await hook(LINE, "PowerShell", { env: { PATH: "C:\\nowhere" } })).reason).not.toContain(RULE);
  });
  it("a path typed without its extension is looked for there", async () => {
    const seen: [string, string | undefined][] = [];
    const onPath = (bin: string, env: NodeJS.ProcessEnv) => {
      seen.push([bin, pathOf(env)]);
      return bin === "az" && pathOf(env) === "C:\\tools" ? "C:\\tools\\az.cmd" : null;
    };
    const { reason } = await hook("& 'C:\\tools\\az' group list --query 'x&y'", "PowerShell", { deps: { ...deps(), onPath } });
    expect(reason).toContain(RULE);
    expect(seen).toContainEqual(["az", "C:\\tools"]);
  });
  it("control: found there as an .exe", async () => {
    const onPath = (bin: string, env: NodeJS.ProcessEnv) => (bin === "az" && pathOf(env) === "C:\\tools" ? "C:\\tools\\az.exe" : null);
    expect((await hook("& 'C:\\tools\\az' group list --query 'x&y'", "PowerShell", { deps: { ...deps(), onPath } })).reason).not.toContain(RULE);
  });
});

describe("PowerShell runs a .ps1 beside the .cmd, so no cmd.exe: on 5.1, under every policy, it ran it or refused it (#168)", () => {
  const LINE = "vercel ls 'x&y'";
  const on = { cwd: withVercel };
  it("a .ps1 in the same folder", async () => {
    resolveTo({ "vercel.ps1": `${BIN}vercel.ps1` });
    expect((await hook(LINE, "PowerShell", on)).reason).not.toContain(RULE);
  });
  it("control: in another folder, which may come after", async () => {
    resolveTo({ "vercel.ps1": "C:\\elsewhere\\vercel.ps1" });
    expect((await hook(LINE, "PowerShell", on)).reason).toContain(RULE);
  });
  it("control: none", async () => {
    expect((await hook(LINE, "PowerShell", on)).reason).toContain(RULE);
  });
  it("typing vercel.cmd runs the .cmd whatever sits beside it", async () => {
    resolveTo({ "vercel.ps1": `${BIN}vercel.ps1` });
    expect((await hook("vercel.cmd ls 'x&y'", "PowerShell", on)).reason).toContain(RULE);
  });
});

describe("cloudpin explain and cloudpin_check say what the hook says (#168)", () => {
  const STOPS = "az group list --query 'x&kubectl'";
  const PASSES = "az group list --query 'x&kubectl get pods'";
  const opts = { mode: "agent" as const, cwd: pinned, env: ENV, shell: "powershell" as const };

  it("explain stops it, naming the class and no value", async () => {
    const [call] = await explain(STOPS, opts, deps());
    expect(call!.verdict).toBe("block");
    expect(call!.problems!.join(" ")).toContain("an unquoted &");
    expect(call!.problems!.join(" ")).not.toContain("kubectl");
    expect(call!.fix).not.toContain("kubectl");
    expect(sent).toEqual([]);
  });
  it("explain passes its control", async () => {
    expect((await explain(PASSES, opts, deps()))[0]!.verdict).toBe("allow");
  });
  it("explain read as bash", async () => {
    expect((await explain(STOPS, { ...opts, shell: "bash" }, deps()))[0]!.verdict).toBe("allow");
  });
  it("explain of a typed .cmd read as bash", async () => {
    expect((await explain("az.cmd group list --query 'x&y'", { ...opts, shell: "bash" }, deps()))[0]!.verdict).toBe("block");
  });
  it("explain of an argv is not a line: no shell reads it", async () => {
    expect((await explain(["az", "group", "list", "--query", "x&kubectl"], opts, deps()))[0]!.verdict).toBe("allow");
  });
  it("explain elsewhere than Windows", async () => {
    expect((await explain(STOPS, opts, deps("linux")))[0]!.verdict).toBe("allow");
  });

  const check = async (command: string, shell: "bash" | "powershell") => {
    const ctx = { cwd: pinned, env: ENV, read: () => null, isDir: () => true, doctor: fakeDoctorHost };
    const tool = cloudpinTools(deps(), ctx).find((t) => t.name === "cloudpin_check")!;
    return (await tool.call({ command, shell })) as { calls: { verdict: string; problems?: string[] }[] };
  };
  it("cloudpin_check stops it", async () => {
    const { calls } = await check(STOPS, "powershell");
    expect(calls[0]!.verdict).toBe("block");
    expect(calls[0]!.problems!.join(" ")).toContain("an unquoted &");
  });
  it("cloudpin_check passes its control, and reads bash as bash", async () => {
    expect((await check(PASSES, "powershell")).calls[0]!.verdict).toBe("allow");
    expect((await check(STOPS, "bash")).calls[0]!.verdict).toBe("allow");
  });
});

describe("no value in what it says (rule 5, #168)", () => {
  const VALUE = "fake-secret-value-for-the-test";
  it("the reason and the fix name the class only", async () => {
    const [call] = await explain(`az group list --query 'x&${VALUE}'`, { mode: "agent", cwd: pinned, env: ENV, shell: "powershell" }, deps());
    expect(call!.verdict).toBe("block");
    expect(JSON.stringify([call!.problems, call!.fix, call!.reason])).not.toContain(VALUE);
  });
  it("a credential flag's value stays masked in the command it quotes", async () => {
    const { decision, reason } = await hook(`az group list --password 'a&${VALUE}'`);
    expect(decision).toBe("deny");
    expect(reason).not.toContain(VALUE);
  });
  it("%NAME% is never expanded into a message", async () => {
    const { reason } = await hook("az group list --query '%ZZP%'", "PowerShell", { env: { ...ENV, ZZP: VALUE } });
    expect(reason).toContain("%NAME%");
    expect(reason).not.toContain(VALUE);
  });
});

describe("a value only known when it runs is read at its worst (#168)", () => {
  it("text around it that cmd.exe acts on stops: the placeholder holds no space or quote", async () => {
    expect((await hook('az group list --query "$v&kubectl"')).reason).toContain(RULE);
  });
  it("alone it is a value cloudpin doesn't need, as elsewhere", async () => {
    expect((await hook("az group list --query $v")).reason).not.toContain(RULE);
  });
});
