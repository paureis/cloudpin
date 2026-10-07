import type { ProviderDef } from "../types.js";
import { aws } from "./aws.js";
import { azure } from "./azure.js";
import { github } from "./github.js";

// gcloud and vercel are not implemented yet (see HANDOFF.md); until then a
// pin for them is reported by `cloudpin check` as unsupported.
export const providers: ProviderDef[] = [azure, aws, github] as ProviderDef[];
