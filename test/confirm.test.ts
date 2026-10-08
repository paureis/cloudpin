import { describe, expect, it } from "vitest";
import { confirmProtected } from "../src/confirm.js";

const verdict = {
  action: "confirm" as const,
  provider: "aws" as const,
  configPath: "/repo/.cloudpin.yml",
  environment: { name: "production", protected: true, source: 'branch "main"' },
};
const argv = ["aws", "s3", "rm", "s3://b/x"];

function io(isTTY: boolean, answer = "") {
  const printed: string[] = [];
  const asked: string[] = [];
  return {
    printed,
    asked,
    isTTY,
    ask: async (q: string) => {
      asked.push(q);
      return answer;
    },
    print: (s: string) => printed.push(s),
  };
}

describe("confirmProtected", () => {
  it.each(["y", "Y", "yes", " yes "])("runs the command when the user answers %j", async (answer) => {
    const t = io(true, answer);
    expect(await confirmProtected(verdict, argv, t)).toBe(true);
    expect(t.asked[0]).toContain("will run on PRODUCTION");
  });

  it.each(["", "n", "no", "maybe"])("does not run it on %j", async (answer) => {
    const t = io(true, answer);
    expect(await confirmProtected(verdict, argv, t)).toBe(false);
    expect(t.printed).toEqual(["cloudpin: not run."]);
  });

  it("stops without asking when there is no terminal, saying how to confirm", async () => {
    const t = io(false, "y");
    expect(await confirmProtected(verdict, argv, t)).toBe(false);
    expect(t.asked).toEqual([]);
    expect(t.printed[0]).toContain("CLOUDPIN_CONFIRM=production aws s3 rm s3://b/x");
  });
});
