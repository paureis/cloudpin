// Real-account smoke test: resolves each provider against the CLIs logged in
// on this machine and shows a matching pin (control) next to a wrong one.
// IDs are shortened to their last 4 characters in the output.
// Usage: npm run build && node scripts/smoke.mjs [provider...]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realExec } from "../dist/exec.js";
import { azure } from "../dist/providers/azure.js";
import { aws } from "../dist/providers/aws.js";
import { github } from "../dist/providers/github.js";
import { kubernetes } from "../dist/providers/kubernetes.js";
import { supabase } from "../dist/providers/supabase.js";

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

async function smokeAws() {
  const res = await aws.resolve(ctx, realExec);
  show("aws resolve", res);
  if (res.kind === "identity") {
    show("pin = active", aws.compare({ account: res.identity.account }, res.identity));
    show("pin = other", aws.compare({ account: "000000000000" }, res.identity));
  }
  show("--profile unknown", await aws.resolve({ ...ctx, args: ["s3", "ls", "--profile", "cloudpin-nope"] }, realExec));
  const dir = mkdtempSync(join(tmpdir(), "cloudpin-aws-"));
  const env = { ...process.env, AWS_CONFIG_FILE: join(dir, "c"), AWS_SHARED_CREDENTIALS_FILE: join(dir, "k"), AWS_EC2_METADATA_DISABLED: "true" };
  for (const k of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) delete env[k];
  show("logged out (empty dir)", await aws.resolve({ ...ctx, env }, realExec));
  rmSync(dir, { recursive: true, force: true });
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

// Reads the kubeconfig only (no cluster is contacted); prints the server and
// namespace, never credentials.
async function smokeKubernetes() {
  const res = await kubernetes.resolve({ ...ctx, args: ["get", "pods"], bin: "kubectl" }, realExec);
  show("kubernetes resolve", res);
  if (res.kind === "identity") {
    show("pin = active", kubernetes.compare({ server: res.identity.server, namespace: res.identity.namespace }, res.identity));
    show("pin = other", kubernetes.compare({ server: "https://cloudpin-nobody:6443" }, res.identity));
    show("-n other vs pinned ns", kubernetes.compare({ server: res.identity.server, namespace: res.identity.namespace },
      (await kubernetes.resolve({ ...ctx, args: ["-ncloudpin-other", "get", "pods"], bin: "kubectl" }, realExec)).identity));
  }
  const empty = mkdtempSync(join(tmpdir(), "cloudpin-kube-"));
  const env = { ...process.env, HOME: empty, USERPROFILE: empty, KUBECONFIG: "" };
  show("no kubeconfig", await kubernetes.resolve({ ...ctx, env, bin: "kubectl" }, realExec));
  rmSync(empty, { recursive: true, force: true });
}

// Read-only: `supabase projects list` only. Takes the first project the login
// can see, pins it in a throwaway folder, and checks a wrong pin and an
// unlinked folder as controls. Refs are shortened; names are not printed.
// Well-formed but invalid; built at runtime so it never sits in the source as a token.
const FAKE_SUPABASE_TOKEN = ["sbp", "0".repeat(40)].join("_");

async function smokeSupabase() {
  const list = await realExec("supabase", ["projects", "list", "--output-format", "json"], process.env);
  const first = list.code === 0 ? JSON.parse(list.stdout).projects?.[0] : undefined;
  if (!first) return show("supabase projects list", { code: list.code, projects: 0 });
  const ref = first.id;
  const brief = (r) => (r.kind === "identity" ? { kind: r.kind, keys: Object.keys(r.identity), source: r.source } : r);
  const dir = mkdtempSync(join(tmpdir(), "cloudpin-supabase-"));
  const res = await supabase.resolve({ ...ctx, cwd: dir, args: ["db", "push", "--project-ref", ref] }, realExec);
  show("supabase resolve", brief(res));
  if (res.kind === "identity") {
    show("pin = active", supabase.compare({ project: ref, org: res.identity.org }, res.identity));
    show("pin = other", supabase.compare({ project: "cloudpinnobodyaaaaaa" }, res.identity).map((p) => p.replace(ref, "…" + ref.slice(-4))));
    show("org = other", supabase.compare({ project: ref, org: "cloudpin-nobody" }, res.identity).length);
  }
  show("unlinked folder", await supabase.resolve({ ...ctx, cwd: dir, args: ["db", "push"] }, realExec));
  const bad = await supabase.resolve({ ...ctx, cwd: dir, args: ["db", "push", "--project-ref", ref], env: { ...process.env, SUPABASE_ACCESS_TOKEN: FAKE_SUPABASE_TOKEN } }, realExec);
  show("bad token", bad.kind === "identity" ? brief(bad) : bad);
  rmSync(dir, { recursive: true, force: true });
}

const wanted = process.argv.slice(2);
const all = { github: smokeGithub, azure: smokeAzure, aws: smokeAws, kubernetes: smokeKubernetes, supabase: smokeSupabase };
for (const [name, run] of Object.entries(all)) {
  if (wanted.length === 0 || wanted.includes(name)) await run();
}
