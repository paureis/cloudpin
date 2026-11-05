import { expect, it } from "vitest";
import { asked, bare, hook, otherPin, type Shell } from "./hook-env-fixture.js";

// #163, the hidden-call family: text that runs, unread. Through the real hook with a real pin file and a fake Exec,
// on the fixture of the environment family: GH_TOKEN picks the account, so `followed` and `notSet` there show a line
// read as what it runs. Each form was run in real Git Bash and Windows PowerShell 5.1 with printers named like the CLIs.

/** Words of the "can't tell" answer every refusal here gives. */
export const HIDDEN = "words only known when it runs";

/**
 * Each shape with CLI: cloudpin can't read what runs, so a guarded call there stops, naming no value. A call that is
 * exempt passes, a line that names no guarded CLI can't name one, and with no pin in play nothing stops.
 */
export function refused(tool: Shell, shapes: string[], env: NodeJS.ProcessEnv = {}) {
  it.each(shapes)("refuses %j", async (shape) => {
    const fill = (call: string) => shape.split("CLI").join(call);
    const stopped = await hook(fill("gh pr list"), tool, env);
    expect(stopped.decision).toBe("deny");
    expect(stopped.reason).toContain(HIDDEN);
    expect((await hook(fill("gh --version"), tool, env)).decision).toBe("allow");
    expect((await hook(fill("gh auth status"), tool, env)).decision).toBe("allow");
    expect((await hook(fill("ls -l"), tool, env)).decision).toBe("allow");
    asked.length = 0;
    expect((await hook(fill("gh pr list"), tool, env, bare)).decision).toBe("allow");
    expect((await hook(fill("gh pr list"), tool, env, otherPin)).decision).toBe("allow");
    expect(asked).toEqual([]);
  });
}
