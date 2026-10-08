// GitHub Actions minutes this repo has used this month, the way private repos
// are billed: each job rounded up to a whole minute, Windows x2, macOS x10.
// Public repos use standard runners for free; the number is still a useful meter.
// Usage: node scripts/ci-minutes.mjs [YYYY-MM]   (needs `gh`, read-only API calls)
import { execFileSync } from "node:child_process";

const REPO = "paureis/cloudpin";
const month = process.argv[2] ?? new Date().toISOString().slice(0, 7);
const MULTIPLIER = { ubuntu: 1, windows: 2, macos: 10 };

const api = (path) => JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8" }));

const pages = api(`repos/${REPO}/actions/runs?per_page=100&created=${month}-01..${month}-31`);
const runs = pages.flatMap((p) => p.workflow_runs);

const byWorkflow = new Map();
const byOs = { ubuntu: 0, windows: 0, macos: 0 };
let total = 0;
for (const run of runs) {
  const jobs = api(`repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`).flatMap((p) => p.jobs);
  for (const job of jobs) {
    if (!job.started_at || !job.completed_at || job.conclusion === "skipped") continue;
    const seconds = (new Date(job.completed_at) - new Date(job.started_at)) / 1000;
    const label = (job.labels ?? []).join(" ").toLowerCase();
    const os = label.includes("windows") ? "windows" : label.includes("macos") ? "macos" : "ubuntu";
    const billed = Math.max(1, Math.ceil(seconds / 60)) * MULTIPLIER[os];
    byOs[os] += billed;
    total += billed;
    byWorkflow.set(run.name, (byWorkflow.get(run.name) ?? 0) + billed);
  }
}

console.log(`${REPO}, ${month}: ${runs.length} runs, ${total} billed minutes`);
console.log(`  by runner: ${Object.entries(byOs).map(([k, v]) => `${k} ${v}`).join(", ")}`);
for (const [name, minutes] of byWorkflow) console.log(`  ${name}: ${minutes}`);
