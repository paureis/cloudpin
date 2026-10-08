import { describe, expect, it } from "vitest";
import { formatBlock } from "../src/format.js";

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
