// Real-account smoke test: resolves each provider against the CLIs logged in
// on this machine and shows a matching pin (control) next to a wrong one.
// Usage: npm run build && node scripts/smoke.mjs [provider...]
import { realExec } from "../dist/exec.js";
import { github } from "../dist/providers/github.js";

const ctx = { args: ["--cloudpin-smoke"], env: process.env, cwd: process.cwd() };

async function smokeGithub() {
  const res = await github.resolve(ctx, realExec);
  console.log("github resolve:", JSON.stringify(res));
  if (res.kind === "identity") {
    console.log("  pin = active ->", JSON.stringify(github.compare({ user: res.identity.user }, res.identity)));
    console.log("  pin = other  ->", JSON.stringify(github.compare({ user: "cloudpin-nobody" }, res.identity)));
  }
  const bad = await github.resolve({ ...ctx, env: { ...process.env, GH_TOKEN: "invalid" } }, realExec);
  console.log("  bad GH_TOKEN ->", JSON.stringify(bad));
}

const wanted = process.argv.slice(2);
const all ={ github: smokeGithub };
for (const [name, run] of Object.entries(all)) {
  if (wanted.length === 0 || wanted.includes(name)) await run();
}
