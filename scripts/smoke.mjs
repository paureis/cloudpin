// Real-account smoke test: resolves each provider against the CLIs logged in
// on this machine and shows a matching pin (control) next to a wrong one.
// IDs are shortened to their last 4 characters in the output.
// Usage: npm run build && node scripts/smoke.mjs [provider...]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realExec } from "../dist/exec.js";
import { azure } from "../dist/providers/azure.js";
import { github } from "../dist/providers/github.js";

const ctx = { args: ["--cloudpin-smoke"], env: process.env, cwd: process.cwd() };
const short = (v) => JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f-]{23}([0-9a-f]{4})/gi, "…$1");
const show = (label, v) => console.log(`  ${label.padEnd(22)} -> ${short(v)}`);

async function smokeGithub() {
  const res = await github.resolve(ctx, realExec);
  show("github resolve", res);
  if (res.kind === "identity") {
    show("pin = active", github.compare({ user: res.identity.user }, res.identity));
    show("pin = other", github.compare({ user: "cloudpin-nobody" }, res.identity));
  }
  show("bad GH_TOKEN", await github.resolve({ ...ctx, env: { ...process.env, GH_TOKEN: "invalid" } }, realExec));
}

async function smokeAzure() {
  const res = await azure.resolve(ctx, realExec);
  show("azure resolve", res);
  if (res.kind === "identity") {
    show("pin = active", azure.compare({ subscription: res.identity.subscription.toUpperCase(), tenant: res.identity.tenant }, res.identity));
    show("pin = other", azure.compare({ subscription: "00000000-0000-0000-0000-000000000000" }, res.identity));
    show("--subscription <name>", await azure.resolve({ ...ctx, args: ["vm", "list", "--subscription", res.identity.name] }, realExec));
  }
  show("--subscription unknown", await azure.resolve({ ...ctx, args: ["vm", "list", "--subscription", "cloudpin-nope"] }, realExec));
  const empty = mkdtempSync(join(tmpdir(), "cloudpin-az-"));
  show("logged out (empty dir)", await azure.resolve({ ...ctx, env: { ...process.env, AZURE_CONFIG_DIR: empty } }, realExec));
  rmSync(empty, { recursive: true, force: true });
}

const wanted = process.argv.slice(2);
const all = { github: smokeGithub, azure: smokeAzure };
for (const [name, run] of Object.entries(all)) {
  if (wanted.length === 0 || wanted.includes(name)) await run();
}
