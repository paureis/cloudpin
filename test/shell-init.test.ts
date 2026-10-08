import { describe, expect, it } from "vitest";
import { shellInit } from "../src/shell-init.js";

const BINS = ["az", "aws", "gcloud", "vercel", "vc", "gh"];

describe("shellInit", () => {
  it.each(["bash", "zsh"])("wraps every guarded CLI for %s", (shell) => {
    const script = shellInit(shell, BINS);
    for (const bin of BINS) {
      expect(script).toContain(`${bin}() { command cloudpin exec -- ${bin} "$@"; }`);
    }
  });

  it("wraps every guarded CLI for PowerShell, passing pipeline input through", () => {
    const script = shellInit("pwsh", BINS);
    for (const bin of BINS) {
      expect(script).toContain(`function ${bin} {`);
      expect(script).toContain(`$input | cloudpin exec -- ${bin} @args`);
    }
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
