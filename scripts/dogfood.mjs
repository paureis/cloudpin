// Sets up (or removes) cloudpin on the owner's machine for a week of real use.
//
//   node scripts/dogfood.mjs install    build, install a packaged copy, add the shell lines and the Claude Code hook
//   node scripts/dogfood.mjs status     show what is installed
//   node scripts/dogfood.mjs uninstall  remove all of it
//
// Every change is reversible by `uninstall`, every edited file is backed up
// first (<file>.cloudpin-backup), and each piece is inert without cloudpin:
// the profile lines only run if `cloudpin` exists, and the shell wrappers
// fall back to the real CLI.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
// This checkout's build edits the hook, so uninstall works even if the package is gone.
const CLI = join(ROOT, "dist", "cli.js");
const START = "# >>> cloudpin (remove with: node scripts/dogfood.mjs uninstall) >>>";
const END = "# <<< cloudpin <<<";
const isWindows = process.platform === "win32";

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", shell: isWindows, ...opts });
  return { code: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

function profiles() {
  const list = [{ path: join(homedir(), ".bashrc"), block: 'command -v cloudpin >/dev/null 2>&1 && eval "$(cloudpin shell-init bash)"' }];
  if (isWindows) {
    const ps = run("powershell", ["-NoProfile", "-Command", "$PROFILE"]).out.split(/\r?\n/).pop();
    if (ps) {
      list.push({
        path: ps,
        block:
          "if (Get-Command cloudpin -CommandType Application -ErrorAction SilentlyContinue) { cloudpin shell-init pwsh | Out-String | Invoke-Expression }",
      });
    }
  }
  return list;
}

function hasBlock(path) {
  return existsSync(path) && readFileSync(path, "utf8").includes(START);
}

function addBlock({ path, block }) {
  if (hasBlock(path)) return `  ${path}: already set up`;
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existsSync(path)) copyFileSync(path, `${path}.cloudpin-backup`);
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const sep = before === "" || before.endsWith("\n") ? "" : eol;
  writeFileSync(path, `${before}${sep}${START}${eol}${block}${eol}${END}${eol}`);
  return `  ${path}: added (backup: ${path}.cloudpin-backup)`;
}

function removeBlock({ path }) {
  if (!hasBlock(path)) return `  ${path}: nothing to remove`;
  const text = readFileSync(path, "utf8");
  const a = text.indexOf(START);
  const b = text.indexOf(END, a);
  if (b === -1) return `  ${path}: start marker without end marker; left unchanged, please edit by hand`;
  let end = b + END.length;
  if (text.slice(end, end + 2) === "\r\n") end += 2;
  else if (text[end] === "\n") end += 1;
  writeFileSync(path, text.slice(0, a) + text.slice(end));
  return `  ${path}: removed`;
}

function installed() {
  return run("npm", ["ls", "-g", "--depth=0", "cloudpin"]).out.includes("cloudpin@");
}

function hookInstalled() {
  const p = join(homedir(), ".claude", "settings.json");
  return existsSync(p) && readFileSync(p, "utf8").includes("cloudpin hook claude");
}

const action = process.argv[2];
if (action === "install") {
  console.log("1. Build and install a packaged copy of cloudpin (independent of this folder)");
  if (run("npm", ["run", "build"], { cwd: ROOT }).code !== 0) throw new Error("build failed");
  const dir = mkdtempSync(join(tmpdir(), "cloudpin-pack-"));
  run("npm", ["pack", "--pack-destination", dir], { cwd: ROOT });
  const tgz = readdirSync(dir).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("npm pack produced no .tgz");
  const tarball = join(dir, tgz);
  const installer = run("socket", ["--version"]).code === 0 ? "socket" : "npm";
  const inst = run(installer, ["npm", "install", "-g", tarball].slice(installer === "npm" ? 1 : 0));
  rmSync(dir, { recursive: true, force: true });
  if (inst.code !== 0) throw new Error(`install failed:\n${inst.out}`);
  console.log(`  installed with ${installer}`);
  console.log("2. Shell wrappers (one guarded line per profile)");
  for (const p of profiles()) console.log(addBlock(p));
  console.log("3. Claude Code hook in your personal settings");
  console.log(`  ${run("node", [CLI, "install-hook", "claude", "--user", "--yes"]).out.split(/\r?\n/).pop()}`);
  console.log("\nDone. Open a new terminal for the wrappers. Projects without a .cloudpin.yml are not affected.");
} else if (action === "uninstall") {
  console.log("1. Claude Code hook");
  console.log(
    hookInstalled()
      ? `  ${run("node", [CLI, "uninstall-hook", "claude", "--user", "--yes"]).out.split(/\r?\n/).pop()}`
      : "  nothing to remove",
  );
  console.log("2. Shell wrappers");
  for (const p of profiles()) console.log(removeBlock(p));
  console.log("3. cloudpin package");
  console.log(installed() ? `  ${run("npm", ["uninstall", "-g", "cloudpin"]).code === 0 ? "removed" : "FAILED"}` : "  not installed");
  console.log("4. Backup copies made by install (no longer needed)");
  const claudeSettings = join(homedir(), ".claude", "settings.json");
  for (const file of [...profiles().map((p) => p.path), claudeSettings]) {
    const backup = `${file}.cloudpin-backup`;
    if (existsSync(backup)) {
      rmSync(backup);
      console.log(`  removed ${backup}`);
    }
  }
  console.log("\nDone. Your .cloudpin.yml files (if any) are left in place; they do nothing without cloudpin.");
} else if (action === "status") {
  console.log(`cloudpin package:   ${installed() ? "installed" : "not installed"}`);
  for (const p of profiles()) console.log(`shell lines:        ${hasBlock(p.path) ? "yes" : "no "}  ${p.path}`);
  console.log(`Claude Code hook:   ${hookInstalled() ? "installed" : "not installed"}`);
} else {
  console.log("usage: node scripts/dogfood.mjs install | status | uninstall");
  process.exitCode = 1;
}
