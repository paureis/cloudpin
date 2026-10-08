import type { ProviderDef } from "../types.js";
import { aws } from "./aws.js";
import { azure } from "./azure.js";
import { gcloud } from "./gcloud.js";
import { github } from "./github.js";

// vercel is not implemented yet (see HANDOFF.md); until then a vercel pin is
// reported by `cloudpin check` as unsupported.
export const providers: ProviderDef[] = [azure, aws, gcloud, github] as ProviderDef[];
