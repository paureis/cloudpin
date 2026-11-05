// How kubectl and helm parse their arguments, read by kubernetes.ts (#153 moved this here).
import { commandWords as wordsAfterFlags } from "../args.js";

/*
 * Short flag groups (#133). kubectl and helm parse flags with spf13/pflag (flag.go,
 * parseShortArg and parseSingleShortArg): a single-dash word is read one letter at a time. A
 * letter that takes no value is one flag; the first letter that takes a value takes the rest
 * of the word (`-itnprod`), or `=value` (`-in=prod`), or the next word when it is the last
 * letter (`-itn prod`). An unknown letter is an error (observed: `kubectl config view -xn foo`
 * says "unknown shorthand flag: 'x' in -xn"), so only letters the command defines matter.
 *
 * The letters below are every one-letter flag of the commands cloudpin guards: kubectl 1.36,
 * `kubectl <command> --help` for each command and `kubectl options`; helm v3.22.1 and v4.3.1
 * source (cmd/helm and pkg/cmd). Neither CLI has a one-letter form of --context, --cluster,
 * --kubeconfig, --user, --kube-context or --kube-apiserver. A letter not listed here (a newer
 * CLI) before one that picks the target means cloudpin can't tell, and stops the command.
 */
function shortLetters(bin: string | undefined, command: string | undefined) {
  if (bin === "helm") {
    // Target: -n (global --namespace) and -A (list --all-namespaces).
    return { targets: "nA", bool: "Aadgiqr", value: "flmno" };
  }
  // -f and -p take a value (--filename, --patch, proxy --port) except in `kubectl logs`
  // (--follow, --previous); -w is --watch except in `kubectl proxy` (--www).
  const logs = command === "logs";
  const proxy = command === "proxy";
  return {
    targets: "nsA",
    bool: `ARiqt${logs ? "fp" : ""}${proxy ? "" : "w"}`,
    value: `LPceklnorsuv${logs ? "" : "fp"}${proxy ? "w" : ""}`,
  };
}

/*
 * Long flags that never take the next word (#153). pflag gives a long flag the next word whole,
 * whatever it holds, unless the flag has a NoOptDefVal (spf13/pflag v1.0.9 flag.go parseLongArg), as
 * every boolean has (bool.go) and `--dry-run`, `--validate`, `--cascade` and helm 4's `--wait` do. Every
 * such flag of kubectl 1.36.1 (kubernetes/kubectl pkg/cmd, kubernetes/cli-runtime
 * pkg/genericclioptions, both at kubernetes-1.36.1) and of helm v3.22.1 and v4.3.1 (cmd/helm, pkg/cmd,
 * pkg/cli), kubectl's `--command` too: it takes a value only in `kuberc set`, which is exempt. A name
 * that takes a value on other commands is listed only for the command where it takes none, below.
 */
const KUBECTL_NO_VALUE = new Set(
  `all all-containers all-namespaces all-pods allow-missing-template-keys append-hash append-server-path arguments-only
  attach cached cascade client command create-annotation current delete-emptydir-data disable-compression
  disable-eviction disable-filter dry-run edit expose flatten follow force force-conflicts global-default help
  ignore-daemonsets ignore-errors ignore-not-found insecure-skip-tls-verify insecure-skip-tls-verify-backend interactive
  keep-annotations keep-init-containers keep-labels keep-liveness keep-readiness keep-startup leave-stdin-open list local
  match-server-version minify name-only namespaced no-headers no-preserve now openapi-patch output-patch
  output-watch-events overwrite previous privileged prune quiet record recursive remove-extra-permissions
  remove-extra-subjects replace resolve rm same-node save-config server-print server-side share-processes show-capacity
  show-events show-kind show-labels show-managed-fields show-secrets show-swap stdin sum timestamps tty
  use-protocol-buffers validate wait warnings-as-errors watch watch-only windows-line-endings`.split(/\s+/),
);
const HELM_NO_VALUE = new Set(
  `all all-namespaces allow-deprecated-repos atomic cleanup-on-fail client create-namespace date debug dependency-update
  deployed devel disable-openapi-validation dry-run enable-dns fail-on-no-result fail-on-repo-update-fail failed force
  force-conflicts force-replace force-update generate-headers generate-name help hide-notes hide-secret ignore-not-found
  include-crds insecure insecure-skip-tls-verify install is-upgrade json keep-history kube-insecure-skip-tls-verify
  list-repo-url logs no-headers no-hooks no-update pass-credentials password-stdin pending plain-http prov quiet
  recreate-pods regexp release-name render-subchart-notes replace reset-then-reuse-values reset-values reuse-values
  reverse rollback-on-failure short show-desc show-resources show-rollback-revision sign skip-crds skip-refresh
  skip-schema-validation skip-tests strict superseded take-ownership uninstalled uninstalling untar validate verify
  versions wait wait-for-jobs with-subcharts`.split(/\s+/),
);

/** Whether a long flag never takes the next word. kubectl reads "_" as "-" (pkg/cmd/cmd.go, WordSepNormalizeFunc). */
function takesNoValue(flag: string, bin: string | undefined, command: string | undefined): boolean {
  const name = flag.slice(2).replaceAll("_", "-");
  if (bin === "helm") return HELM_NO_VALUE.has(name) || (name === "server-side" && command === "install");
  return (
    KUBECTL_NO_VALUE.has(name) || (name === "prefix" && command === "logs") || (name === "containers" && command === "top")
  );
}

// The long flags `selectors` and `allNamespaces` read, by the name pflag gives them.
const TARGET_LONG = new Set([
  "kubeconfig", "kuberc", "context", "cluster", "server", "namespace", "all-namespaces", "kube-context", "kube-apiserver",
]);

/** Whether a word would pick the cluster or namespace if pflag read it as a flag, by shortLetters' `letters`. */
function picksTarget(word: string, letters: ReturnType<typeof shortLetters>): boolean {
  if (word.startsWith("--")) return TARGET_LONG.has(word.slice(2).split("=")[0]!.replaceAll("_", "-"));
  if (word.length < 2 || word[0] !== "-") return false;
  for (const letter of word.slice(1)) {
    if (letters.targets.includes(letter)) return true;
    // The rest of the word is this letter's value. An unknown letter is the group reader's to stop.
    if (letter === "=" || letters.value.includes(letter)) return false;
  }
  return false;
}

/**
 * The arguments with each short flag group split as pflag reads it, so `-itn prod` becomes
 * `-i -t -n=prod` and `flag` and `allNamespaces` see its namespace. A value taken from the next
 * word is joined to its flag with `=`, because pflag gives it that word whatever it holds:
 * `-c -n x` is the container "-n" (`-c=-n`), and `-c --` doesn't end the flags. The same goes for
 * the global long flags in VALUE_FLAGS (`--namespace -n` is `--namespace=-n`). A group whose letters
 * cloudpin doesn't all know, when a letter after the unknown one could pick the target, is returned
 * as a reason instead. Only the letter is named: a word may hold a value.
 *
 * Any other long flag may be one of kubectl's per-command flags that take a value, whose list isn't
 * kept (#153): without "=", and followed by a word that starts with "-", that word is its value or a
 * flag. If it or a word after it would pick the target, the two readings can differ (`--container
 * -n x`, `--selector -o -n x`, `--selector -- -n x`), so that is a reason as well. The flag is the
 * first one reached, so it is a flag whichever way what follows is read, and its name holds no value.
 * `command` picks the letter table; it is the alias's command for a kuberc alias.
 */
export function splitShortGroups(
  args: string[],
  bin: string | undefined,
  command = commandWords(args)[0],
): string[] | { error: string } {
  const letters = shortLetters(bin, command);
  const { targets, bool, value } = letters;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return [...out, ...args.slice(i)];
    if (arg.startsWith("--")) {
      if (VALUE_FLAGS.has(arg) && i + 1 < args.length) {
        out.push(`${arg}=${args[++i]}`);
        continue;
      }
      const next = args[i + 1];
      if (
        next !== undefined && next.length > 1 && next[0] === "-" && !arg.includes("=") &&
        !takesNoValue(arg, bin, command) && args.slice(i + 1).some((word) => picksTarget(word, letters))
      ) {
        return {
          error: `cloudpin doesn't know whether ${bin ?? "kubectl"}'s flag ${arg} takes a value, and the next word starts with "-", so it can't tell which cluster or namespace the command uses; write ${arg}=<value> (${arg}=true if it takes none)`,
        };
      }
      out.push(arg);
      continue;
    }
    // pflag reads a lone `-` as an argument (parseArgs).
    if (arg.length < 2 || arg[0] !== "-") {
      out.push(arg);
      continue;
    }
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j]!;
      const rest = arg.slice(j + 1);
      if (bool.includes(letter) && !rest.startsWith("=")) {
        out.push(`-${letter}`);
        continue;
      }
      if (!bool.includes(letter) && !value.includes(letter) && [...rest].some((l) => targets.includes(l))) {
        return {
          error: `cloudpin doesn't know ${bin ?? "kubectl"}'s flag -${letter}, so it can't tell whether the letters after it in the same word pick the namespace or server`,
        };
      }
      // A value letter (or a boolean given `=value`) takes the rest of the word, or the next
      // word when it is the last letter. With no next word pflag fails ("flag needs an argument").
      if (rest === "" && value.includes(letter) && i + 1 < args.length) out.push(`-${letter}=${args[++i]}`);
      else out.push(`-${letter}${rest}`);
      break;
    }
  }
  return out;
}

// Global flags that take a value (`kubectl options`, helm.sh/docs/helm/helm), so
// in `kubectl --context prod delete ...` the word "prod" is not the command.
const VALUE_FLAGS = new Set([
  "--as", "--as-group", "--as-uid", "--as-user-extra", "--cache-dir", "--certificate-authority",
  "--client-certificate", "--client-key", "--cluster", "--context", "--kubeconfig", "--kuberc",
  "--log-flush-frequency", "-n", "--namespace", "--password", "--profile", "--profile-output",
  "--request-timeout", "-s", "--server", "--tls-server-name", "--token", "--user", "--username", "-v", "--v",
  "--vmodule",
  "--burst-limit", "--kube-apiserver", "--kube-as-group", "--kube-as-user", "--kube-ca-file", "--kube-context",
  "--kube-tls-server-name", "--kube-token", "--qps", "--registry-config", "--repository-cache", "--repository-config",
]);

/**
 * The command's words with flags and global flag values left out, e.g.
 * ["delete", "pod", "x"] for `kubectl -n web --context prod delete pod x`.
 * Only global flags come before the command word, and kubectl and helm reject
 * unknown ones, so the first word is the command.
 */
export function commandWords(args: string[]): string[] {
  return wordsAfterFlags(args, VALUE_FLAGS);
}
