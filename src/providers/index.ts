import type { ProviderDef } from "../types.js";
import { aws } from "./aws.js";
import { cloudflare } from "./cloudflare.js";
import { azure } from "./azure.js";
import { gcloud } from "./gcloud.js";
import { github } from "./github.js";
import { kubernetes } from "./kubernetes.js";
import { supabase } from "./supabase.js";
import { vercel } from "./vercel.js";

export const providers: ProviderDef[] = [azure, aws, gcloud, vercel, github, kubernetes, supabase, cloudflare] as ProviderDef[];
