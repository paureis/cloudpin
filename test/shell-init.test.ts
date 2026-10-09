import { spawnSync } from "node:child_process";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellInit } from "../src/shell-init.js";
import { tempDir } from "./tmp.js";

const BINS = ["az", "aws", "gcloud", "vercel", "vc", "gh"];

describe("shellInit", () => {
  it.each(["bash", "zsh"])("wraps every guarded CLI for %s, falling back to it if cloudpin is gone", (shell) => {
    const script = shellInit(shell, BINS);
    for (const bin of BINS) {
      // `function name {`, not `name() {`: an existing alias would break the latter (#69).
      expect(script).toContain(
        `function ${bin} { if command -v cloudpin >/dev/null 2>&1; then command cloudpin exec -- ${bin} "$@"; else command ${bin} "$@"; fi; }`,
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

/** Is `shell` on PATH? Never on Windows, where `bash` may be WSL's rather than a real one for the test. */
function available(shell: string): boolean {
  if (process.platform === "win32") return false;
  return spawnSync(shell, ["-c", "exit 0"]).status === 0;
}

/** A folder with fake `cloudpin`, `kubectl` and `gh` that say who ran. */
function fakeBins(): string {
  const dir = tempDir("cloudpin-shell-");
  const write = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  write("cloudpin", 'echo "GUARDED $*"');
  write("kubectl", 'echo "REAL kubectl $*"');
  write("gh", 'echo "REAL gh $*"');
  return dir;
}

// Run in real shells (#69): only a real parser shows what an alias does to a function definition.
describe.each(["bash", "zsh"])("the %s wrappers in a real shell", (shell) => {
  const run = (prelude: string, path: (bins: string) => string = (bins) => `${bins}:/usr/bin:/bin`) => {
    const bins = fakeBins();
    const file = join(bins, "test.sh");
    writeFileSync(
      file,
      // bash expands aliases only in interactive shells unless told to; zsh always does.
      ['[ -n "$BASH_VERSION" ] && shopt -s expand_aliases', prelude, 'eval "$CLOUDPIN_INIT"', 'echo "eval rc=$?"', "kubectl get pods", "gh pr list", ""].join("\n"),
    );
    const res = spawnSync(shell, [file], {
      env: { PATH: path(bins), HOME: bins, CLOUDPIN_INIT: shellInit(shell, ["kubectl", "gh"]) },
      encoding: "utf8",
    });
    return { stdout: res.stdout, stderr: res.stderr };
  };

  it.skipIf(!available(shell))("guards every CLI, and warns about nothing, without aliases", () => {
    const { stdout, stderr } = run("");
    expect(stdout).toBe("eval rc=0\nGUARDED exec -- kubectl get pods\nGUARDED exec -- gh pr list\n");
    expect(stderr).toBe("");
  });

  it.skipIf(!available(shell))("still guards a CLI whose alias calls the CLI itself", () => {
    const { stdout, stderr } = run("alias kubectl='kubectl --context c'\nalias gh='\\gh'");
    expect(stdout).toBe("eval rc=0\nGUARDED exec -- kubectl --context c get pods\nGUARDED exec -- gh pr list\n");
    expect(stderr).toBe("");
  });

  it.skipIf(!available(shell))("warns at start-up about an alias that runs another program, and guards the rest", () => {
    const { stdout, stderr } = run("alias kubectl='kubecolor'\nalias gh='command gh'");
    expect(stdout).toContain("eval rc=0\n");
    for (const [bin, alias] of [["kubectl", "kubecolor"], ["gh", "command gh"]]) {
      expect(stderr).toContain(`cloudpin: alias ${bin}='${alias}' runs another program, so ${bin} is not guarded in this shell`);
    }
  });

  it.skipIf(!available(shell))("runs the real CLI when cloudpin is gone", () => {
    const { stdout } = run("", (bins) => {
      const only = tempDir("cloudpin-nocp-");
      for (const name of ["kubectl", "gh"]) symlinkSync(join(bins, name), join(only, name));
      return `${only}:/usr/bin:/bin`;
    });
    expect(stdout).toBe("eval rc=0\nREAL kubectl get pods\nREAL gh pr list\n");
  });
});

describe("the PowerShell wrappers in Windows PowerShell", () => {
  it.skipIf(process.platform !== "win32")("warn at start-up about an alias, which PowerShell runs before a function", () => {
    const init = shellInit("pwsh", ["kubectl", "gh"]);
    const res = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Set-Alias gh hub; $env:CLOUDPIN_INIT | Out-String | Invoke-Expression; 'done'"],
      { env: { ...process.env, CLOUDPIN_INIT: init }, encoding: "utf8" },
    );
    const out = res.stdout + res.stderr;
    expect(out).toContain("done");
    expect(out).toContain("cloudpin: alias gh -> hub runs instead of the cloudpin wrapper, so gh is not guarded in this shell");
    expect(out).not.toContain("alias kubectl");
  });
});
