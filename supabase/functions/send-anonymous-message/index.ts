import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';
import { corsHeaders } from '../_shared/cors.ts';
import { jsonResponse, sha256Base64 } from '../_shared/intake.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Metode tidak diizinkan.' }, 405, corsHeaders);

  try {
    const body = await req.json() as Record<string, unknown>;
    const nomorLaporan = String(body.nomorLaporan ?? '').trim().toUpperCase();
    const kunciRahasia = String(body.kunciRahasia ?? '').trim().toUpperCase();
    const pesan = String(body.pesan ?? '').trim();

    if (!nomorLaporan || !kunciRahasia) return jsonResponse({ error: 'Nomor Laporan dan Kunci Rahasia wajib diisi.' }, 400, corsHeaders);
    if (pesan.length < 1 || pesan.length > 5000) return jsonResponse({ error: 'Pesan harus berisi 1–5.000 karakter.' }, 400, corsHeaders);

    const suppliedHash = await sha256Base64(kunciRahasia);
    const { data, error } = await admin.rpc('send_anonymous_reporter_message_atomic', {
      p_public_case_id: nomorLaporan,
      p_supplied_hash: suppliedHash,
      p_message: pesan,
    });
    if (error) throw error;
    if (!data?.ok) {
      if (data?.code === 'LOCKED') return jsonResponse({ error: 'Akses sementara dikunci karena terlalu banyak percobaan. Coba lagi beberapa saat lagi.' }, 429, corsHeaders);
      if (data?.code === 'CASE_CLOSED') return jsonResponse({ error: 'Laporan ini sudah ditutup dan tidak menerima pesan baru.' }, 409, corsHeaders);
      return jsonResponse({ error: 'Nomor Laporan atau Kunci Rahasia tidak sesuai.' }, 403, corsHeaders);
    }
    return jsonResponse(data, 201, corsHeaders);
  } catch (error) {
    console.error('send-anonymous-message', error);
    return jsonResponse({ error: 'Pesan belum dapat dikirim. Silakan coba kembali.' }, 400, corsHeaders);
  }
});
