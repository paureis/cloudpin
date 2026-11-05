import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FoundConfig } from "../src/config.js";
import { guard } from "../src/guard.js";
import { kubernetes } from "../src/providers/kubernetes.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// #153 item 4. pflag gives a long flag the next word whole unless the flag has a NoOptDefVal, as every
// boolean has (spf13/pflag v1.0.9 flag.go parseLongArg, bool.go). `kubectl logs pod --container -n x`
// is the container "-n" and the argument "x", with no namespace set. Which long flags take a value
// depends on the command, so a word after a long flag cloudpin can't place is either a flag or a value.

const noExec: Exec = async () => {
  throw new Error("kubernetes must not spawn a process");
};

const CONFIG = `apiVersion: v1
kind: Config
current-context: prod
clusters:
- name: prod-cluster
  cluster:
    server: https://prod.example.com
contexts:
- name: prod
  context:
    cluster: prod-cluster
    namespace: payments
- name: other
  context:
    cluster: prod-cluster
    namespace: other-ns
`;

function home(): string {
  const dir = tempDir("cloudpin-kube-long-");
  mkdirSync(join(dir, ".kube"));
  writeFileSync(join(dir, ".kube", "config"), CONFIG);
  return dir;
}

const split = (line: string) => line.split(" ");
const resolve = (line: string, bin = "kubectl", dir = home()) =>
  kubernetes.resolve({ args: split(line), env: { HOME: dir }, cwd: "/repo", bin }, noExec);

async function namespace(line: string, bin = "kubectl", dir = home()) {
  const res = await resolve(line, bin, dir);
  return res.kind === "identity" ? res.identity.namespace : `${res.kind}: ${"message" in res ? res.message : ""}`;
}

const ALL = "(all namespaces)";

describe("a long flag that may take the next word as its value stops as can't tell (#153)", () => {
  it.each([
    // The word right after it would pick the target.
    "logs pod --container -n x",
    "logs pod --container -nx",
    "logs pod --container -n=x",
    "logs pod --container --namespace x",
    "logs pod --container --namespace=x",
    "logs pod --container -itn x",
    "get pods --selector -A",
    "get pods --selector -wA",
    "get pods --selector --all-namespaces",
    "get pods --selector --all_namespaces",
    "get pods --selector --context other",
    "get pods --selector --context=other",
    "get pods --selector --cluster prod-cluster",
    "get pods --selector -s https://other.example.com",
    "get pods --selector --server=https://other.example.com",
    "get pods --selector --kubeconfig /elsewhere",
    "get pods --selector --kuberc /elsewhere",
    // Read as a flag, the next word would take the target word as its own value.
    "get pods --selector -o -n x",
    "logs pod --container -c -n x",
    "get pods --selector --output -n x",
    // A boolean before it doesn't hide it.
    "delete pod --force --selector -n x",
    // `--` is its value, or the end of the flags (flag.go parseArgs).
    "delete pods --selector -- -n x",
    "get pods --selector -o -- -n x",
    // An unknown letter is left to the group reader, which stops too.
    "get pods --selector -xn x",
    // A flag of the same name that takes a value here and none on another command.
    "set env deploy/x --prefix -n x",
    "set env deploy/x --containers -n x",
    "get --raw -n x",
    // Not a kubectl flag, or newer than this list.
    "get pods --from-the-future -n x",
    // A plugin reads its own flags.
    "myplugin --flag -n x",
  ])("kubectl %s", async (line) => {
    const res = await resolve(line);
    expect(res.kind).toBe("error");
    expect(res.kind === "error" && res.message).toMatch(/can't tell/);
  });

  it.each([
    "upgrade rel chart --set -n x",
    "upgrade rel chart --values --namespace x",
    "list --filter -A",
    "list --filter --kube-context other",
    "list --filter --kube-apiserver=https://other.example.com",
    "list --filter --kubeconfig /elsewhere",
    "list --filter -o -n x",
    "uninstall rel --cascade -- -n x",
    "upgrade rel chart --server-side -n x",
  ])("helm %s", async (line) => {
    const res = await resolve(line, "helm");
    expect(res.kind).toBe("error");
    expect(res.kind === "error" && res.message).toMatch(/can't tell/);
  });

  it("names the flag and never a value", async () => {
    const res = await resolve("logs pod --container -n value-here --token token-here");
    expect(res.kind === "error" && res.message).toContain("--container");
    expect(res.kind === "error" && res.message).toContain("--container=<value>");
    expect(JSON.stringify(res)).not.toContain("value-here");
    expect(JSON.stringify(res)).not.toContain("token-here");
  });

  it("names the flag cloudpin reached first, which is never a value of another", async () => {
    const res = await resolve("get pods --selector --looks-like-a-value -n x");
    expect(res.kind === "error" && res.message).toContain("--selector");
    expect(JSON.stringify(res)).not.toContain("looks-like-a-value");
  });
});

describe("controls: long flags that are read as before (#153)", () => {
  it.each([
    // Every kubectl boolean from pkg/cmd, and the optional-value ones, read normally.
    "get pods --watch -n prod",
    "get pods --watch-only -n prod",
    "get pods --show-labels -n prod",
    "get pods --no-headers -n prod",
    "get pods --ignore-not-found -n prod",
    "get pods --server-print -n prod",
    "logs pod --follow -n prod",
    "logs pod --previous -n prod",
    "logs pod --timestamps -n prod",
    "logs pod --all-containers -n prod",
    "logs pod --ignore-errors -n prod",
    "exec pod --stdin --tty -n prod -- sh",
    "run x --rm --attach -n prod",
    "run x --command -n prod -- sh",
    "delete pods --all -n prod",
    "delete pod x --force -n prod",
    "delete pod x --now -n prod",
    "delete pod x --wait -n prod",
    "delete pod x --cascade -n prod",
    "apply -f x --server-side -n prod",
    "apply -f x --force-conflicts -n prod",
    "apply -f x --prune -n prod",
    "apply -f x --recursive -n prod",
    "apply -f x --dry-run -n prod",
    "apply -f x --validate -n prod",
    "apply -f x --save-config -n prod",
    "annotate pod x a=b --overwrite -n prod",
    "drain node --ignore-daemonsets --delete-emptydir-data -n prod",
    "auth can-i --list -n prod",
    "get pods --insecure-skip-tls-verify -n prod",
    "get pods --disable-compression -n prod",
    "get pods --match-server-version -n prod",
    "get pods --warnings-as-errors -n prod",
    // pflag's normalisation of "_" (kubectl pkg/cmd/cmd.go, component-base WordSepNormalizeFunc).
    "get pods --no_headers -n prod",
    // The two that take a value on other commands, on the commands where they take none.
    "logs pod --prefix -n prod",
    "top pod --containers -n prod",
    // A long flag's value in the same word, or a next word that can't be a flag.
    "logs pod --container=x -n prod",
    "logs pod --container x -n prod",
    "get pods --selector app=x -n prod",
    "get pods --output wide -n prod",
    "get pods --filename - -n prod",
    "get pods --from-the-future x -n prod",
  ])("kubectl %s reads namespace prod", async (line) => {
    expect(await namespace(line)).toBe("prod");
  });

  it.each([
    // Nothing after the flag picks a target, so both readings agree.
    "get pods --from-the-future -o wide",
    "get pods --from-the-future -ojsonpath={.n}",
    "get pods --from-the-future -w=n",
    "get pods --from-the-future",
    "get pods --from-the-future=x",
    "exec pod --from-the-future -- sh -c true",
    // A real `--`: what follows goes to the command in the pod.
    "exec pod --container main -- kubectl get pods -n other",
    "exec pod --stdin -- kubectl get pods -n other",
    "exec pod --stdin --tty -- ls -n",
    "get pods --selector=-n",
    "get pods --output -o",
  ])("kubectl %s keeps the kubeconfig namespace", async (line) => {
    expect(await namespace(line)).toBe("payments");
  });

  it("reads a boolean's own --all-namespaces", async () => {
    expect(await namespace("get pods --all-namespaces --watch")).toBe(ALL);
    expect(await namespace("get pods --watch --all-namespaces")).toBe(ALL);
  });

  it("reads a global flag's value after a boolean, and the last namespace", async () => {
    expect(await namespace("get pods --watch --namespace prod")).toBe("prod");
    expect(await namespace("get pods --force --context other")).toBe("other-ns");
    expect(await namespace("get pods --watch -n first --all -n second")).toBe("second");
  });

  it("keeps #145: a global flag's value and a short flag's value are values", async () => {
    expect(await namespace("get pods --namespace -n")).toBe("-n");
    expect(await namespace("logs pod -c -n x")).toBe("payments");
  });

  it.each([
    "upgrade rel chart --install --atomic --wait -n prod",
    "upgrade rel chart --reuse-values -n prod",
    "upgrade rel chart --reset-values --wait-for-jobs -n prod",
    "upgrade rel chart --dry-run -n prod",
    "upgrade rel chart --set a=b -n prod",
    "upgrade rel chart --rollback-on-failure --force-replace -n prod",
    "install rel chart --create-namespace -n prod",
    "install rel chart --generate-name --debug -n prod",
    "install rel chart --server-side -n prod",
    "uninstall rel --keep-history --dry-run -n prod",
    "list --deployed --failed --short -n prod",
    "rollback rel 1 --cleanup-on-fail -n prod",
    "test rel --logs -n prod",
    "history rel --kube-insecure-skip-tls-verify -n prod",
  ])("helm %s reads namespace prod", async (line) => {
    expect(await namespace(line, "helm")).toBe("prod");
  });

  it("helm's --all-namespaces", async () => {
    expect(await namespace("list --all-namespaces --short", "helm")).toBe(ALL);
  });

  it("an alias follows the flags of the command it runs", async () => {
    const dir = home();
    writeFileSync(
      join(dir, ".kube", "kuberc"),
      "apiVersion: kubectl.config.k8s.io/v1beta1\nkind: Preference\naliases:\n- name: lg\n  command: logs\n",
    );
    expect(await namespace("lg pod --prefix -n prod", "kubectl", dir)).toBe("prod");
    expect(await namespace("logs pod --prefix -n prod", "kubectl", dir)).toBe("prod");
    expect((await resolve("lg pod --container -n x", "kubectl", dir)).kind).toBe("error");
  });
});

describe("guard with a long flag (#153)", () => {
  const verdict = (line: string, namespace: string, bin = "kubectl") => {
    const config: FoundConfig = {
      path: "/repo/.cloudpin.yml",
      pins: { kubernetes: { server: "https://prod.example.com", namespace } },
    };
    return guard(
      { bin, args: split(line), env: { HOME: home() }, cwd: "/repo", mode: "agent" },
      { providers: [kubernetes], exec: noExec, findConfig: () => config },
    );
  };

  it("doesn't allow a command that would run outside the pinned namespace it names", async () => {
    // pflag: no namespace is set, so kubectl runs in the kubeconfig's "payments", not "x".
    const v = await verdict("logs pod --container -n x", "x");
    expect(v.action).toBe("block");
    expect(v.action === "block" && v.uncertain).toBe(true);
    expect(v.action === "block" && v.problems.join(" ")).not.toContain('"x"');
  });

  it("doesn't allow it with helm either", async () => {
    const v = await verdict("uninstall rel --cascade -n x", "x", "helm");
    expect(v.action === "block" && v.uncertain).toBe(true);
  });

  it("stops the same word when the pin is the kubeconfig's namespace", async () => {
    // Read as a boolean, --from-the-future -n x is namespace "x", not the pinned one.
    const v = await verdict("get pods --from-the-future -n x", "payments");
    expect(v.action === "block" && v.uncertain).toBe(true);
  });

  it("allows the pinned namespace after a boolean", async () => {
    expect((await verdict("get pods --watch -n prod", "prod")).action).toBe("allow");
    expect((await verdict("logs pod --container=x -n prod", "prod")).action).toBe("allow");
  });

  it("blocks another namespace after a boolean, as a mismatch", async () => {
    const v = await verdict("get pods --watch -n other", "prod");
    expect(v.action).toBe("block");
    expect(v.action === "block" && v.uncertain).toBeFalsy();
    expect(v.action === "block" && v.problems.join(" ")).toContain('"other"');
  });
});
