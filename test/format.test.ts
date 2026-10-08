import { describe, expect, it } from "vitest";
import { formatBlock, formatConfirm } from "../src/format.js";

const verdict = {
  action: "block" as const,
  provider: "github" as const,
  configPath: "/repo/.cloudpin.yml",
  problems: ['user: expected "paureis", active is "someone"'],
  fix: "gh auth switch --user paureis",
};

describe("formatBlock", () => {
  it("explains what was blocked, why, and how to fix it", () => {
    expect(formatBlock(verdict, ["gh", "pr", "list"], "shell")).toBe(
      [
        "cloudpin: blocked `gh pr list`",
        "  github is pinned in /repo/.cloudpin.yml",
        '  - user: expected "paureis", active is "someone"',
        "  fix: gh auth switch --user paureis",
        "  (to run it anyway, once: CLOUDPIN_SKIP=1 gh pr list)",
      ].join("\n"),
    );
  });

  it("tells an agent to ask the human instead of offering the override", () => {
    const text = formatBlock(verdict, ["gh", "pr", "list"], "agent");
    expect(text).not.toContain("CLOUDPIN_SKIP");
    expect(text).toContain("Do not work around this; ask the user to switch accounts or confirm.");
  });

  it("quotes arguments that contain spaces", () => {
    expect(formatBlock(verdict, ["az", "vm", "list", "--subscription", "My Sub"], "shell")).toContain(
      "blocked `az vm list --subscription \"My Sub\"`",
    );
  });

  it("omits lines it has nothing for", () => {
    const text = formatBlock({ action: "block", problems: ["invalid config: x"] }, ["gh"], "shell");
    expect(text).toBe(
      ["cloudpin: blocked `gh`", "  - invalid config: x", "  (to run it anyway, once: CLOUDPIN_SKIP=1 gh)"].join("\n"),
    );
  });

  it("says plainly when it stopped because it could not tell the account", () => {
    const uncertain = {
      action: "block" as const,
      uncertain: true,
      provider: "github" as const,
      configPath: "/repo/.cloudpin.yml",
      problems: ["gh api user failed (exit 1)"],
      fix: "gh auth status",
    };
    expect(formatBlock(uncertain, ["gh", "pr", "list"], "shell")).toBe(
      [
        "cloudpin: stopped `gh pr list` because it could not tell which github account it would use",
        "  github is pinned in /repo/.cloudpin.yml",
        "  - reason: gh api user failed (exit 1)",
        "  This is a safety stop: cloudpin blocks whenever it cannot confirm the account.",
        "  to see what is wrong: gh auth status",
        "  (to run it anyway, once: CLOUDPIN_SKIP=1 gh pr list)",
      ].join("\n"),
    );
  });
});

describe("environment messages", () => {
  const production = { name: "production", protected: true, source: 'branch "main"' };
  const confirm = {
    action: "confirm" as const,
    provider: "github" as const,
    configPath: "/repo/.cloudpin.yml",
    environment: production,
  };
  const argv = ["gh", "pr", "merge", "12"];

  it("names the environment when blocking", () => {
    expect(formatBlock({ ...verdict, environment: production }, argv, "shell")).toContain(
      '  environment: production (protected), chosen by branch "main"',
    );
  });

  it("asks a human at the terminal", () => {
    expect(formatConfirm(confirm, argv, "prompt")).toBe(
      'cloudpin: `gh pr merge 12` will run on PRODUCTION, a protected environment (chosen by branch "main").\nContinue? [y/N] ',
    );
  });

  it("tells a script how to confirm ahead of time", () => {
    expect(formatConfirm(confirm, argv, "no-terminal")).toBe(
      [
        "cloudpin: stopped `gh pr merge 12`: production is a protected environment and there is no terminal to confirm",
        '  the github account matches /repo/.cloudpin.yml (environment chosen by branch "main")',
        "  to run it: CLOUDPIN_CONFIRM=production gh pr merge 12",
      ].join("\n"),
    );
  });

  it("explains the question an agent puts to the user", () => {
    expect(formatConfirm(confirm, argv, "agent-ask")).toBe(
      'cloudpin: `gh pr merge 12` would run on the protected environment "production" (chosen by branch "main"). ' +
        "The github account matches the pin, but this command may change something, so it needs your OK.",
    );
  });

  it("tells an agent that cannot ask to hand the command to the user", () => {
    const text = formatConfirm(confirm, argv, "agent-deny");
    expect(text).toContain('it would run on the protected environment "production"');
    expect(text).toContain("ask the user to run it themselves");
    expect(text).not.toContain("CLOUDPIN_CONFIRM");
  });
});
