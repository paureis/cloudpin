import { describe, expect, it } from "vitest";
import { shellInit } from "../src/shell-init.js";

const BINS = ["az", "aws", "gcloud", "vercel", "vc", "gh"];

describe("shellInit", () => {
  it.each(["bash", "zsh"])("wraps every guarded CLI for %s, falling back to it if cloudpin is gone", (shell) => {
    const script = shellInit(shell, BINS);
    for (const bin of BINS) {
      expect(script).toContain(
        `${bin}() { if command -v cloudpin >/dev/null 2>&1; then command cloudpin exec -- ${bin} "$@"; else command ${bin} "$@"; fi; }`,
      );
    }
  });

  it("wraps every guarded CLI for PowerShell, passing pipeline input through", () => {
    const script = shellInit("pwsh", BINS);
    for (const bin of BINS) {
      expect(script).toContain(`function ${bin} {`);
      expect(script).toContain(`$input | cloudpin exec -- ${bin} @args`);
    }
  });

  it("falls back in PowerShell to the real executable (never the function itself) without cloudpin", () => {
    const script = shellInit("pwsh", ["gh"]);
    expect(script).toContain("Get-Command cloudpin -CommandType Application -ErrorAction SilentlyContinue");
    expect(script).toContain("(Get-Command gh -CommandType Application | Select-Object -First 1).Source");
  });

  it("accepts powershell as an alias for pwsh", () => {
    expect(shellInit("powershell", BINS)).toBe(shellInit("pwsh", BINS));
  });

  it("explains how to install and remove it", () => {
    expect(shellInit("bash", BINS)).toContain('eval "$(cloudpin shell-init bash)"');
    expect(shellInit("pwsh", BINS)).toContain("cloudpin shell-init pwsh | Out-String | Invoke-Expression");
  });

  it("rejects an unknown shell", () => {
    expect(() => shellInit("fish", BINS)).toThrow(/unsupported shell "fish"/);
  });
});
