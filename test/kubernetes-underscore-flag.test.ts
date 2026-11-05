import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kubernetes } from "../src/providers/kubernetes.js";
import type { Exec } from "../src/types.js";
import { tempDir } from "./tmp.js";

// kubectl reads "_" as "-" in a flag's name (pkg/cmd/cmd.go, WordSepNormalizeFunc): kubectl 1.36.1 accepts
// `get pods --all_namespaces` and refuses `--bogus_flag`, so --all_namespaces is --all-namespaces.

const noExec: Exec = async () => {
  throw new Error("kubernetes must not spawn a process");
};

function home(): string {
  const dir = tempDir("cloudpin-kube-underscore-");
  mkdirSync(join(dir, ".kube"));
  writeFileSync(
    join(dir, ".kube", "config"),
    `apiVersion: v1
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
`,
  );
  return dir;
}

async function namespace(line: string) {
  const res = await kubernetes.resolve({ args: line.split(" "), env: { HOME: home() }, cwd: "/repo", bin: "kubectl" }, noExec);
  return res.kind === "identity" ? res.identity.namespace : res.kind;
}

describe("kubectl's --all_namespaces is --all-namespaces", () => {
  it.each(["get pods --all_namespaces", "get pods --all_namespaces=true", "get pods --all-namespaces", "get pods -A"])(
    "%s targets all namespaces",
    async (line) => {
      expect(await namespace(line)).toBe("(all namespaces)");
    },
  );

  it.each(["get pods --all_namespaces=false", "get pods", "get pods --all_containers"])("%s stays in the kubeconfig's", async (line) => {
    expect(await namespace(line)).toBe("payments");
  });
});
