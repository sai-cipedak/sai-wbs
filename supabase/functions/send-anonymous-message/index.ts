import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';
import { corsHeaders } from '../_shared/cors.ts';
import { jsonResponse, sha256Base64, timingSafeEqual } from '../_shared/intake.ts';

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

    const { data: caseRow } = await admin
      .from('cases')
      .select('id, organization_id, public_case_id, reporting_mode')
      .eq('public_case_id', nomorLaporan)
      .eq('reporting_mode', 'ANONYMOUS')
      .maybeSingle();
    if (!caseRow) return jsonResponse({ error: 'Nomor Laporan atau Kunci Rahasia tidak sesuai.' }, 403, corsHeaders);

    const { data: access } = await admin
      .from('case_anonymous_access')
      .select('secret_hash, failed_attempts, locked_until')
      .eq('case_id', caseRow.id)
      .single();
    if (!access) return jsonResponse({ error: 'Nomor Laporan atau Kunci Rahasia tidak sesuai.' }, 403, corsHeaders);

    if (access.locked_until && Date.parse(access.locked_until) > Date.now()) {
      return jsonResponse({ error: 'Akses sementara dikunci karena terlalu banyak percobaan. Coba lagi beberapa saat lagi.' }, 429, corsHeaders);
    }

    const suppliedHash = await sha256Base64(kunciRahasia);
    const valid = timingSafeEqual(new TextEncoder().encode(suppliedHash), new TextEncoder().encode(access.secret_hash));
    if (!valid) {
      const failed = Number(access.failed_attempts ?? 0) + 1;
      const lockedUntil = failed >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
      await admin.from('case_anonymous_access').update({ failed_attempts: failed >= 5 ? 0 : failed, locked_until: lockedUntil }).eq('case_id', caseRow.id);
      return jsonResponse({ error: 'Nomor Laporan atau Kunci Rahasia tidak sesuai.' }, 403, corsHeaders);
    }

    await admin.from('case_anonymous_access').update({ failed_attempts: 0, locked_until: null, last_used_at: new Date().toISOString() }).eq('case_id', caseRow.id);

    const { data: createdMessage, error: messageError } = await admin
      .from('case_messages')
      .insert({ case_id: caseRow.id, sender_type: 'REPORTER', body: pesan, visible_to_reporter: true })
      .select('id, created_at')
      .single();
    if (messageError || !createdMessage) throw messageError ?? new Error('Gagal menyimpan pesan.');

    await admin.from('audit_logs').insert({
      organization_id: caseRow.organization_id,
      case_id: caseRow.id,
      event_type: 'REPORTER_MESSAGE_SENT',
      object_type: 'case_message',
      object_id: createdMessage.id,
      details: {},
    });

    return jsonResponse({ ok: true, id: createdMessage.id, waktu: createdMessage.created_at }, 201, corsHeaders);
  } catch (error) {
    console.error('send-anonymous-message', error);
    return jsonResponse({ error: 'Pesan belum dapat dikirim. Silakan coba kembali.' }, 400, corsHeaders);
  }
});
