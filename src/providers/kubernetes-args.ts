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

/**
 * The arguments with each short flag group split as pflag reads it, so `-itn prod` becomes
 * `-i -t -n=prod` and `flag` and `allNamespaces` see its namespace. A value taken from the next
 * word is joined to its flag with `=`, because pflag gives it that word whatever it holds:
 * `-c -n x` is the container "-n" (`-c=-n`), and `-c --` doesn't end the flags. The same goes for
 * the global long flags in VALUE_FLAGS (`--namespace -n` is `--namespace=-n`); other long flags
 * are kubectl's per-command ones, too many to list, so their value is left as it is. A group
 * whose letters cloudpin doesn't all know, when a letter after the unknown one could pick the
 * target, is returned as a reason instead. Only the letter is named: a word may hold a value.
 * `command` picks the letter table; it is the alias's command for a kuberc alias.
 */
export function splitShortGroups(
  args: string[],
  bin: string | undefined,
  command = commandWords(args)[0],
): string[] | { error: string } {
  const { targets, bool, value } = shortLetters(bin, command);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return [...out, ...args.slice(i)];
    if (arg.startsWith("--")) {
      out.push(VALUE_FLAGS.has(arg) && i + 1 < args.length ? `${arg}=${args[++i]}` : arg);
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
