import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { publicKeyFetch, supabasePublicConfig } from './supabase-public-config';
import type { PublicStoreDatabase } from './store-types';

let browserClient: SupabaseClient<PublicStoreDatabase> | undefined;
export function getSupabaseBrowser(): SupabaseClient<PublicStoreDatabase> {
  if (typeof window === 'undefined') throw new Error('Browser client must be used after hydration.');
  browserClient ??= createClient<PublicStoreDatabase>(supabasePublicConfig.url, supabasePublicConfig.publishableKey, { global: { fetch: publicKeyFetch } });
  return browserClient;
}