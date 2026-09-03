import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.4/+esm';

const config = window.WBS_CONFIG;
if (!config?.SUPABASE_URL || !config?.SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('Konfigurasi portal belum lengkap.');
}

export const supabaseClient = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);

export async function invokePublic(functionName, body, method = 'POST') {
  const response = await fetch(`${config.SUPABASE_URL}/functions/v1/${functionName}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: config.SUPABASE_PUBLISHABLE_KEY },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Permintaan belum dapat diproses.');
  return data;
}
