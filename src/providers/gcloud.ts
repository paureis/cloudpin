import { flagValue, hasAnyFlag, leadingWords } from "../args.js";
import type { ProviderDef } from "../types.js";

// Setup and housekeeping groups: logins, local config, SDK components, docs.
const EXEMPT_COMMANDS = new Set(["auth", "config", "init", "version", "info", "help", "topic", "components"]);
// Global flags that change which account/project a command uses
// (`gcloud topic configurations`). The env (CLOUDSDK_CORE_ACCOUNT,
// CLOUDSDK_CORE_PROJECT, CLOUDSDK_ACTIVE_CONFIG_NAME, CLOUDSDK_CONFIG)
// reaches gcloud unchanged.
const IDENTITY_FLAGS = ["--account", "--project", "--configuration"];

export const gcloud: ProviderDef<"gcloud"> = {
  name: "gcloud",
  bins: ["gcloud"],
  statusCommand: "gcloud config list",

  isExempt(args) {
    if (hasAnyFlag(args, ["--version", "--help", "-h"])) return true;
    const [first] = leadingWords(args);
    return first !== undefined && EXEMPT_COMMANDS.has(first);
  },

  async resolve({ args, env }, exec) {
    // `gcloud config list` given the same flags and env reports the account
    // and project the command would use (verified for flags, CLOUDSDK_CORE_*
    // and named configurations on SDK 588).
    const query = ["config", "list", "--format=json"];
    for (const flag of IDENTITY_FLAGS) {
      const value = flagValue(args, [flag]);
      if (value !== undefined) query.push(flag, value);
    }
    const res = await exec("gcloud", query, env);
    if (res.code !== 0) {
      const reason = /^ERROR: (.+)$/m.exec(res.stderr)?.[1]?.trim().slice(0, 300);
      return {
        kind: "error",
        message: reason ? `gcloud: ${reason}` : `gcloud config list failed (exit ${res.code})`,
      };
    }
    let core: { account?: string; project?: string };
    try {
      core = (JSON.parse(res.stdout) as { core?: typeof core }).core ?? {};
    } catch {
      return { kind: "error", message: "could not read gcloud config list output" };
    }
    // No account also covers an unknown --configuration, which gcloud reports
    // as an empty config with exit 0 rather than as an error.
    if (!core.account) return { kind: "logged-out", hint: "gcloud auth login" };
    return {
      kind: "identity",
      identity: { account: core.account, project: core.project ?? "" },
      source: "gcloud config list",
    };
  },

  compare(pin, identity) {
    const out: string[] = [];
    // Google account emails compare case-insensitively; project IDs are lowercase by rule.
    if (pin.account && identity.account?.toLowerCase() !== pin.account.toLowerCase()) {
      out.push(`account: expected "${pin.account}", active is "${identity.account}"`);
    }
    if (pin.project && identity.project !== pin.project) {
      const active = identity.project ? `"${identity.project}"` : "(not set)";
      out.push(`project: expected "${pin.project}", active is ${active}`);
    }
    return out;
  },

  switchHint(pin) {
    const steps: string[] = [];
    if (pin.account) steps.push(`gcloud config set account ${pin.account}`);
    if (pin.project) steps.push(`gcloud config set project ${pin.project}`);
    return steps.join(" && ");
  },
};
