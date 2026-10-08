import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./tmp.js";
import { kubernetes } from "../src/providers/kubernetes.js";
import type { Exec, Resolution } from "../src/types.js";

// Identity comes from kubeconfig files, so no CLI is ever run.
const noExec: Exec = async () => {
  throw new Error("kubernetes must not spawn a process");
};

const CONFIG_A = `apiVersion: v1
kind: Config
current-context: dev
clusters:
- name: dev-cluster
  cluster:
    server: https://dev.example.com:6443
- name: prod-cluster
  cluster:
    server: https://PROD.example.com/
contexts:
- name: dev
  context:
    cluster: dev-cluster
    user: me
- name: prod
  context:
    cluster: prod-cluster
    user: me
    namespace: payments
users:
- name: me
  user:
    token: not-a-real-token
`;

function home(config = CONFIG_A) {
  const dir = tempDir("cloudpin-kube-");
  mkdirSync(join(dir, ".kube"));
  writeFileSync(join(dir, ".kube", "config"), config);
  return dir;
}

async function resolve(args: string[], env: NodeJS.ProcessEnv, bin = "kubectl"): Promise<Resolution> {
  return kubernetes.resolve({ args, env, cwd: "/repo", bin }, noExec);
}

const identity = (server: string, namespace: string, context: string) => ({
  kind: "identity",
  identity: { server, namespace, context },
  source: "kubeconfig",
});

describe("kubernetes.resolve: kubectl", () => {
  it("uses the current context of ~/.kube/config, defaulting the namespace", async () => {
    expect(await resolve(["get", "pods"], { HOME: home() })).toEqual(
      identity("https://dev.example.com:6443", "default", "dev"),
    );
  });

  it("follows --context, and the context's namespace", async () => {
    expect(await resolve(["--context", "prod", "get", "pods"], { HOME: home() })).toEqual(
      identity("https://PROD.example.com/", "payments", "prod"),
    );
  });

  it.each([
    [["-n", "kube-system", "delete", "pod", "x"]],
    [["--namespace=kube-system", "delete", "pod", "x"]],
    [["-n=kube-system", "delete", "pod", "x"]],
    [["-nkube-system", "delete", "pod", "x"]],
    [["delete", "pod", "x", "--namespace", "kube-system"]],
  ])("reads the namespace flag in every form kubectl accepts: %j", async (args) => {
    expect(await resolve(args, { HOME: home() })).toMatchObject({ identity: { namespace: "kube-system" } });
  });

  it("does not read flags after --", async () => {
    expect(await resolve(["exec", "pod", "--", "ls", "-n", "x"], { HOME: home() })).toMatchObject({
      identity: { namespace: "default" },
    });
  });

  it.each([[["get", "pods", "-A"]], [["get", "pods", "--all-namespaces"]], [["get", "pods", "--all-namespaces=true"]]])(
    "marks %j as targeting all namespaces",
    async (args) => {
      expect(await resolve(args, { HOME: home() })).toMatchObject({ identity: { namespace: "(all namespaces)" } });
    },
  );

  it("follows --cluster and --server overrides", async () => {
    expect(await resolve(["--cluster", "prod-cluster", "get", "pods"], { HOME: home() })).toMatchObject({
      identity: { server: "https://PROD.example.com/" },
    });
    expect(await resolve(["-s", "https://other:6443", "get", "pods"], { HOME: home() })).toMatchObject({
      identity: { server: "https://other:6443" },
    });
    expect(await resolve(["--server=https://other:6443", "get", "pods"], { HOME: home() })).toMatchObject({
      identity: { server: "https://other:6443" },
    });
  });

  it("merges KUBECONFIG files, the first to set a value winning", async () => {
    const dir = tempDir("cloudpin-kube-merge-");
    const first = join(dir, "first.yaml");
    const second = join(dir, "second.yaml");
    writeFileSync(first, "current-context: prod\nclusters:\n- name: prod-cluster\n  cluster:\n    server: https://first\n");
    writeFileSync(second, CONFIG_A);
    const env = { HOME: home(), KUBECONFIG: [join(dir, "missing.yaml"), first, "", second].join(delimiter) };
    expect(await resolve(["get", "pods"], env)).toEqual(identity("https://first", "payments", "prod"));
  });

  it("keeps the first file's definition of a context defined twice", async () => {
    const dir = tempDir("cloudpin-kube-merge-");
    const first = join(dir, "first.yaml");
    writeFileSync(first, "contexts:\n- name: prod\n  context:\n    cluster: dev-cluster\n    namespace: first-ns\n");
    const second = join(dir, "second.yaml");
    writeFileSync(second, CONFIG_A);
    const env = { HOME: home(), KUBECONFIG: [first, second].join(delimiter) };
    expect(await resolve(["--context", "prod", "get", "pods"], env)).toEqual(
      identity("https://dev.example.com:6443", "first-ns", "prod"),
    );
  });

  it("uses only --kubeconfig when given, ignoring KUBECONFIG", async () => {
    const dir = tempDir("cloudpin-kube-flag-");
    const only = join(dir, "only.yaml");
    writeFileSync(only, CONFIG_A.replace("current-context: dev", "current-context: prod"));
    const env = { HOME: home(), KUBECONFIG: join(dir, "nope.yaml") };
    expect(await resolve(["--kubeconfig", only, "get", "pods"], env)).toMatchObject({ identity: { context: "prod" } });
    expect(await resolve(["--kubeconfig", join(dir, "nope.yaml"), "get", "pods"], env)).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/kubeconfig .*nope\.yaml was not found/),
    });
  });

  it("reports no kubeconfig or no current context as not logged in", async () => {
    expect(await resolve(["get", "pods"], { HOME: tempDir("cloudpin-kube-empty-") })).toMatchObject({ kind: "logged-out" });
    expect(await resolve(["get", "pods"], { HOME: home(CONFIG_A.replace("current-context: dev\n", "")) })).toMatchObject({
      kind: "logged-out",
      hint: expect.stringContaining("kubectl config use-context"),
    });
  });

  it("fails closed on a context or cluster that is not defined", async () => {
    expect(await resolve(["--context", "nope", "get", "pods"], { HOME: home() })).toMatchObject({
      kind: "error",
      message: 'context "nope" is not defined in the kubeconfig',
    });
    expect(await resolve(["--cluster", "nope", "get", "pods"], { HOME: home() })).toMatchObject({
      kind: "error",
      message: 'cluster "nope" is not defined in the kubeconfig',
    });
  });

  it("never puts kubeconfig content in an error, which may hold credentials", async () => {
    const res = await resolve(["get", "pods"], { HOME: home("users:\n- name: me\n  user:\n    token: s3cr3t-value\n  [broken\n") });
    expect(res.kind).toBe("error");
    expect(JSON.stringify(res)).not.toContain("s3cr3t");
  });
});

describe("kubernetes.resolve: helm", () => {
  it("follows --kube-context and --namespace", async () => {
    expect(await resolve(["--kube-context", "prod", "-n", "web", "upgrade", "x", "./chart"], { HOME: home() }, "helm")).toEqual(
      identity("https://PROD.example.com/", "web", "prod"),
    );
  });

  it("follows HELM_KUBECONTEXT, HELM_NAMESPACE and HELM_KUBEAPISERVER, with flags winning", async () => {
    const env = { HOME: home(), HELM_KUBECONTEXT: "prod", HELM_NAMESPACE: "env-ns", HELM_KUBEAPISERVER: "https://api-env" };
    expect(await resolve(["install", "x", "./chart"], env, "helm")).toEqual(identity("https://api-env", "env-ns", "prod"));
    expect(await resolve(["install", "x", "./chart", "--kube-context=dev", "--namespace", "flag-ns"], { ...env, HELM_KUBEAPISERVER: "" }, "helm")).toEqual(
      identity("https://dev.example.com:6443", "flag-ns", "dev"),
    );
  });

  it("ignores kubectl's --context and --cluster flags, which helm does not have", async () => {
    expect(await resolve(["--context", "prod", "list"], { HOME: home() }, "helm")).toMatchObject({ identity: { context: "dev" } });
  });
});

describe("kubernetes.isExempt", () => {
  it.each([
    ["kubectl", ["config", "use-context", "prod"]],
    ["kubectl", ["version", "--client"]],
    ["kubectl", ["kustomize", "."]],
    ["kubectl", ["delete", "pod", "x", "--help"]],
    ["kubectl", ["completion", "bash"]],
    ["helm", ["template", "x", "./chart"]],
    ["helm", ["repo", "add", "a", "https://x"]],
    ["helm", ["lint", "./chart"]],
    ["helm", ["version"]],
  ])("%s %j never touches a cluster", (bin, args) => {
    expect(kubernetes.isExempt(args as string[], bin)).toBe(true);
  });

  it.each([
    ["kubectl", ["delete", "pod", "x"]],
    ["kubectl", ["apply", "-k", "."]],
    ["kubectl", ["get", "pods"]],
    ["kubectl", ["explain", "pods"]],
    ["kubectl", ["--context", "prod", "delete", "pod", "x"]],
    ["kubectl", []],
    ["helm", ["upgrade", "x", "./chart"]],
    ["helm", ["uninstall", "x"]],
    ["helm", ["config"]],
  ])("%s %j is guarded", (bin, args) => {
    expect(kubernetes.isExempt(args as string[], bin)).toBe(false);
  });
});

describe("kubernetes.compare", () => {
  const id = { server: "https://PROD.example.com/", namespace: "payments", context: "prod" };

  it("matches the server ignoring scheme/host case and a trailing slash", () => {
    expect(kubernetes.compare({ server: "https://prod.example.com" }, id)).toEqual([]);
  });

  it("reports a different server", () => {
    expect(kubernetes.compare({ server: "https://dev.example.com:6443" }, id)).toEqual([
      'server: expected "https://dev.example.com:6443", active is "https://PROD.example.com/" (context "prod")',
    ]);
  });

  it("checks the namespace only when one is pinned", () => {
    expect(kubernetes.compare({ server: "https://prod.example.com", namespace: "payments" }, id)).toEqual([]);
    expect(kubernetes.compare({ server: "https://prod.example.com", namespace: "web" }, id)).toEqual([
      'namespace: expected "web", the command uses "payments"',
    ]);
    expect(kubernetes.compare({ server: "https://prod.example.com", namespace: "web" }, { ...id, namespace: "(all namespaces)" })).toEqual([
      'namespace: expected "web", the command targets all namespaces',
    ]);
  });
});

describe("kubernetes.resolve: kuberc (kubectl 1.33+)", () => {
  // kubernetes.io/docs/reference/kubectl/kuberc/: defaults can set options such
  // as namespace, and aliases can add arguments.
  const KUBERC = `apiVersion: kubectl.config.k8s.io/v1beta1
kind: Preference
defaults:
  - command: delete
    options:
      - name: interactive
        default: "true"
  - command: apply
    options:
      - name: namespace
        default: other
aliases:
  - name: getn
    command: get
    options:
      - name: output
        default: json
  - name: getp
    command: get
    prependArgs:
      - --context=prod
`;
  function withKuberc(text = KUBERC) {
    const dir = home();
    writeFileSync(join(dir, ".kube", "kuberc"), text);
    return dir;
  }

  it("ignores defaults that do not pick the target", async () => {
    expect(await resolve(["delete", "pod", "x"], { HOME: withKuberc() })).toMatchObject({ kind: "identity" });
    expect(await resolve(["getn", "pods"], { HOME: withKuberc() })).toMatchObject({ kind: "identity" });
  });

  it("fails closed when a default for this command sets the namespace", async () => {
    expect(await resolve(["apply", "-f", "x.yaml"], { HOME: withKuberc() })).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/kuberc .* sets "namespace" for "apply"/),
    });
  });

  it("fails closed when the alias used sets the context", async () => {
    expect(await resolve(["getp", "pods"], { HOME: withKuberc() })).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/alias "getp"/),
    });
  });

  it("honours KUBERC=off, KUBECTL_KUBERC=false and a KUBERC path", async () => {
    const dir = withKuberc();
    expect(await resolve(["apply", "-f", "x"], { HOME: dir, KUBERC: "off" })).toMatchObject({ kind: "identity" });
    expect(await resolve(["apply", "-f", "x"], { HOME: dir, KUBECTL_KUBERC: "false" })).toMatchObject({ kind: "identity" });
    const elsewhere = join(tempDir("cloudpin-kuberc-"), "kuberc");
    writeFileSync(elsewhere, KUBERC);
    expect(await resolve(["apply", "-f", "x"], { HOME: home(), KUBERC: elsewhere })).toMatchObject({ kind: "error" });
    expect(await resolve(["--kuberc", elsewhere, "apply", "-f", "x"], { HOME: home() })).toMatchObject({ kind: "error" });
  });

  it("does not apply kuberc to helm", async () => {
    expect(await resolve(["upgrade", "x", "./c"], { HOME: withKuberc() }, "helm")).toMatchObject({ kind: "identity" });
  });
});
