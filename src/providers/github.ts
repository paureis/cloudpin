import { flagValue, hasAnyFlag, leadingWords } from "../args.js";
import type { ProviderDef } from "../types.js";

const DEFAULT_HOST = "github.com";
const EXEMPT_COMMANDS = new Set(["auth", "version", "help", "completion"]);
// gh exits 4 when a command needs authentication (`gh help exit-codes`).
const EXIT_AUTH_REQUIRED = 4;

export const github: ProviderDef<"github"> = {
  name: "github",
  bins: ["gh"],

  isExempt(args) {
    if (hasAnyFlag(args, ["--version", "--help", "-h"])) return true;
    const [first] = leadingWords(args);
    return first !== undefined && EXEMPT_COMMANDS.has(first);
  },

  async resolve({ args, env }, exec) {
    const host = flagValue(args, ["--hostname"]) ?? env.GH_HOST ?? DEFAULT_HOST;
    // Asking the API (instead of reading gh's config) means GH_TOKEN,
    // GITHUB_TOKEN and enterprise tokens are honoured exactly as gh would.
    const res = await exec("gh", ["api", "user", "--hostname", host, "--jq", ".login"], env);
    if (res.code === EXIT_AUTH_REQUIRED) {
      return { kind: "logged-out", hint: `gh auth login --hostname ${host}` };
    }
    const login = res.stdout.trim();
    if (res.code !== 0 || login === "") {
      return { kind: "error", message: `gh api user failed (exit ${res.code})` };
    }
    return { kind: "identity", identity: { user: login, host }, source: "gh api user" };
  },

  compare(pin, identity) {
    const out: string[] = [];
    const host = pin.host ?? DEFAULT_HOST;
    if (identity.host?.toLowerCase() !== host.toLowerCase()) {
      out.push(`host: expected "${host}", active is "${identity.host}"`);
    }
    // GitHub logins are case-insensitive.
    if (identity.user?.toLowerCase() !== pin.user.toLowerCase()) {
      out.push(`user: expected "${pin.user}", active is "${identity.user}"`);
    }
    return out;
  },

  switchHint(pin) {
    const host = pin.host && pin.host !== DEFAULT_HOST ? ` --hostname ${pin.host}` : "";
    return `gh auth switch${host} --user ${pin.user}`;
  },
};
