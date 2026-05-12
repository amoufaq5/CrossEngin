import type { KernelContext } from "@crossengin/kernel";

export const SUPABASE_ADAPTER_VERSION = "0.0.0";

export interface SupabaseAdapterConfig {
  readonly url: string;
  readonly serviceKey: string;
}

export interface SupabaseAdapter {
  readonly version: typeof SUPABASE_ADAPTER_VERSION;
  withContext(_ctx: KernelContext): SupabaseAdapter;
}
