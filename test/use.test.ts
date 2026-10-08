import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./tmp.js";
import { chooseEnvironment } from "../src/git.js";
import { useCommand } from "../src/use.js";

const ENVS = "environments:\n  staging: {}\n  production:\n    protected: true\nbranches:\n  main: production\n";

function project(config = ENVS, git = true) {
  const root = tempDir("cloudpin-use-");
  if (git) {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  }
  writeFileSync(join(root, ".cloudpin.yml"), config);
  return root;
}

describe("cloudpin use", () => {
  it("shows the environments and which one applies", () => {
    const root = project();
    expect(useCommand([], root, {})).toEqual({
      code: 0,
      lines: [
        `cloudpin: environments in ${join(root, ".cloudpin.yml")}`,
        "    staging",
        '  * production (protected)  <- chosen by branch "main"',
        "Choose one here with: cloudpin use <name>   (forget it with: cloudpin use --clear)",
      ],
    });
  });

  it("remembers a choice in the git folder", () => {
    const root = project();
    const result = useCommand(["staging"], root, {});
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe("cloudpin: using staging here (remembered for this clone, not committed)");
    expect(chooseEnvironment(join(root, ".git"))).toBe("staging");
    expect(useCommand([], root, {}).lines).toContain("  * staging  <- chosen by cloudpin use");
  });

  it("warns when CLOUDPIN_ENV overrides the choice", () => {
    const root = project();
    expect(useCommand(["staging"], root, { CLOUDPIN_ENV: "production" }).lines).toContain(
      "  note: CLOUDPIN_ENV=production is set in this shell and takes precedence",
    );
  });

  it("forgets the choice with --clear, even when it names an environment that no longer exists", () => {
    const root = project();
    chooseEnvironment(join(root, ".git"), "removed");
    expect(useCommand(["--clear"], root, {}).code).toBe(0);
    expect(chooseEnvironment(join(root, ".git"))).toBeNull();
  });

  it("can replace a stale choice", () => {
    const root = project();
    chooseEnvironment(join(root, ".git"), "removed");
    expect(useCommand(["staging"], root, {}).code).toBe(0);
    expect(useCommand([], root, {}).code).toBe(0);
  });

  it("refuses an unknown environment, listing the defined ones", () => {
    expect(useCommand(["prod"], project(), {})).toEqual({
      code: 1,
      lines: ['cloudpin use: no environment "prod" (defined: staging, production)'],
    });
  });

  it("explains when the file has no environments", () => {
    const result = useCommand(["staging"], project("github:\n  user: x\n"), {});
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(/defines no environments/);
  });

  it("explains when there is no pin file", () => {
    expect(useCommand([], tempDir("cloudpin-use-none-"), {}).lines[0]).toMatch(/no \.cloudpin\.yml/);
  });

  it("needs a git repository to remember a choice, and points to CLOUDPIN_ENV", () => {
    const result = useCommand(["staging"], project(ENVS, false), {});
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(/not in a git repository.*CLOUDPIN_ENV=staging/);
  });
});
