import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Owner rule: every release updates the docs. Bumping package.json without
// them makes this fail, so the release PR can't go green with stale docs.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const { version } = JSON.parse(read("package.json")) as { version: string };

describe(`docs for release ${version}`, () => {
  it("README names it as the latest release", () => {
    expect(read("README.md")).toContain(`**Latest release: ${version}**`);
  });

  it("CHANGELOG has its entry", () => {
    expect(read("CHANGELOG.md")).toMatch(new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"));
  });

  it("ROADMAP lists it as shipped", () => {
    expect(read("ROADMAP.md")).toContain(`- **${version}**`);
  });

  it("the bug report form suggests it as the example version", () => {
    expect(read(".github/ISSUE_TEMPLATE/bug_report.yml")).toContain(`cloudpin ${version},`);
  });
});
