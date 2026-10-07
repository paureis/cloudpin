import { flagValue, hasAnyFlag, leadingWords } from "../args.js";
import type { ProviderDef } from "../types.js";

const EXEMPT_COMMANDS = new Set(["login", "logout", "version", "upgrade"]);
// Account housekeeping only; `account get-access-token` stays guarded.
const EXEMPT_ACCOUNT_SUBCOMMANDS = new Set(["set", "show", "list", "clear"]);

export const azure: ProviderDef<"azure"> = {
  name: "azure",
  bins: ["az"],

  isExempt(args) {
    if (hasAnyFlag(args, ["--version", "--help", "-h"])) return true;
    const [first, second] = leadingWords(args);
    if (first === undefined) return false;
    if (EXEMPT_COMMANDS.has(first)) return true;
    return first === "account" && second !== undefined && EXEMPT_ACCOUNT_SUBCOMMANDS.has(second);
  },

  async resolve({ args, env }, exec) {
    // `--subscription` is az's global flag (name or ID). Short `-s` is not:
    // subcommands reuse it (e.g. `az webapp ... -s <slot>`), so it is ignored.
    const subscription = flagValue(args, ["--subscription"]);
    const query = ["account", "show", "--output", "json"];
    if (subscription !== undefined) query.push("--subscription", subscription);

    // `az account show --subscription <name|id>` maps a name to its ID for us.
    const res = await exec("az", query, env);
    if (res.code !== 0) {
      if (/az login/.test(res.stderr)) return { kind: "logged-out", hint: "az login" };
      // az explains itself on an `ERROR:` line (unknown or ambiguous
      // subscription names, expired sessions); pass that reason on.
      const reason = /^ERROR: (.+)$/m.exec(res.stderr)?.[1]?.trim().slice(0, 300);
      return {
        kind: "error",
        message: reason ? `az: ${reason}` : `az account show failed (exit ${res.code})`,
      };
    }
    try {
      const account = JSON.parse(res.stdout) as { id?: string; tenantId?: string; name?: string };
      if (!account.id || !account.tenantId) throw new Error("missing fields");
      return {
        kind: "identity",
        identity: { subscription: account.id, tenant: account.tenantId, name: account.name ?? "" },
        source: "az account show",
      };
    } catch {
      return { kind: "error", message: "could not read az account show output" };
    }
  },

  compare(pin, identity) {
    const out: string[] = [];
    // Subscription and tenant IDs are GUIDs, which compare case-insensitively.
    if (identity.subscription?.toLowerCase() !== pin.subscription.toLowerCase()) {
      const label = identity.name ? ` (${identity.name})` : "";
      out.push(`subscription: expected "${pin.subscription}", active is "${identity.subscription}"${label}`);
    }
    if (pin.tenant && identity.tenant?.toLowerCase() !== pin.tenant.toLowerCase()) {
      out.push(`tenant: expected "${pin.tenant}", active is "${identity.tenant}"`);
    }
    return out;
  },

  switchHint(pin) {
    return `az account set --subscription ${pin.subscription}`;
  },
};
