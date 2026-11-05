import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { calls, hook } from "./hook-line-env-fixture.js";
import { tempDir } from "./tmp.js";

// A kubeconfig can name an exec credential plugin (kubernetes.io, client-go credential plugins), which client-go runs
// when credentials are needed. cloudpin takes the server and namespace from the file and connects to nothing, so a line
// pointing KUBECONFIG at such a file, or setting helm's or kubectl's plugin folders, starts no process during a check.
const SERVER = "https://printer.example:6443";
const folder = realpathSync(tempDir("cloudpin-kube-exec-"));
writeFileSync(join(folder, ".cloudpin.yml"), `kubernetes:\n  server: ${SERVER}\n`);
const config = join(folder, "kubeconfig");
writeFileSync(
  config,
  `apiVersion: v1
kind: Config
current-context: p
clusters:
- name: c
  cluster:
    server: ${SERVER}
contexts:
- name: p
  context:
    cluster: c
    user: u
users:
- name: u
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1
      command: ./plugin-that-must-not-run
      interactiveMode: Never
`,
);

describe("kubeconfig exec plugins and helm's plugins start nothing during the check", () => {
  it.each([
    `KUBECONFIG='${config}' kubectl get pods`,
    `KUBECONFIG='${config}' helm list`,
    `KUBECONFIG='${config}' HELM_PLUGINS=/planted helm list`,
    `kubectl --kubeconfig '${config}' get pods`,
  ])("%s", async (line) => {
    const answer = await hook(line, { cwd: folder });
    expect(answer.decision).toBe("allow");
    expect(calls).toEqual([]);
  });

  it("the server in the file still decides: a control that can fail", async () => {
    const other = join(folder, "other");
    writeFileSync(other, `apiVersion: v1\nkind: Config\ncurrent-context: p\nclusters:\n- name: c\n  cluster:\n    server: https://other.example\ncontexts:\n- name: p\n  context:\n    cluster: c\n    user: u\nusers:\n- name: u\n  user: {}\n`);
    expect((await hook(`KUBECONFIG='${other}' kubectl get pods`, { cwd: folder })).decision).toBe("deny");
    expect(calls).toEqual([]);
  });
});
