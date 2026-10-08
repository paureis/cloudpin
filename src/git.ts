import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The repository's git folder at or above `startDir`, read from disk so no
 * process is spawned. A worktree's `.git` is a file holding `gitdir: <path>`
 * (git-scm.com/docs/gitrepository-layout), which points at its own folder.
 */
export function findGitDir(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit;
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
      if (match) return isAbsolute(match[1]!) ? match[1]! : resolve(dir, match[1]!);
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The checked-out branch, or null on a detached HEAD or an unreadable repository. */
export function currentBranch(gitDir: string): string | null {
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
  } catch {
    return null;
  }
}

// Inside the git folder, so it is per clone and per worktree and never committed.
const CHOICE_FILE = "cloudpin-env";

/**
 * Reads the environment chosen with `cloudpin use` (no `name` argument),
 * remembers one (a name), or forgets it (null).
 */
export function chooseEnvironment(gitDir: string, name?: string | null): string | null {
  const path = join(gitDir, CHOICE_FILE);
  if (name === undefined) {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8").trim() || null;
  }
  if (name === null) rmSync(path, { force: true });
  else writeFileSync(path, `${name}\n`);
  return name;
}
