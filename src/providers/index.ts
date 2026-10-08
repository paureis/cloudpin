import type { ProviderDef } from "../types.js";
import { aws } from "./aws.js";
import { azure } from "./azure.js";
import { gcloud } from "./gcloud.js";
import { github } from "./github.js";
import { kubernetes } from "./kubernetes.js";
import { vercel } from "./vercel.js";

export const providers: ProviderDef[] = [azure, aws, gcloud, vercel, github, kubernetes] as ProviderDef[];
