// Public browser configuration, NOT a service-role or secret key.
const existingProjectUrl = 'https://qebdpjzhbqzjbvjqeztl.supabase.co';
export const supabasePublicConfig = {
  url: import.meta.env.VITE_SUPABASE_URL || existingProjectUrl,
  publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable__NZtJ8Oxla1t4zHNrwccFw_EeUjC2br',
};
if (supabasePublicConfig.url !== existingProjectUrl) {
  throw new Error('TaajaMandi must connect only to its existing production project.');
}

export function publicKeyFetch(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (headers.get('Authorization') === `Bearer ${supabasePublicConfig.publishableKey}`) headers.delete('Authorization');
  headers.set('apikey', supabasePublicConfig.publishableKey);
  return fetch(input, { ...init, headers });
}