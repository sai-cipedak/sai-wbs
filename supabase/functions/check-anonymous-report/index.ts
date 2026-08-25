import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';
import { corsHeaders } from '../_shared/cors.ts';
import { CLASSIFICATION_LABELS, jsonResponse, sha256Base64, STATUS_LABELS, timingSafeEqual } from '../_shared/intake.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const OUTCOME_LABELS: Record<string, string> = {
  PROVEN: 'Terbukti',
  PARTIALLY_PROVEN: 'Sebagian Terbukti',
  NOT_PROVEN: 'Tidak Terbukti',
  INCONCLUSIVE: 'Tidak Dapat Disimpulkan',
  NOT_EXAMINABLE: 'Tidak Dapat Diperiksa',
  OUT_OF_SCOPE: 'Di Luar Ruang Lingkup',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Metode tidak diizinkan.' }, 405, corsHeaders);

  try {
    const body = await req.json() as Record<string, unknown>;
    const nomorLaporan = String(body.nomorLaporan ?? '').trim().toUpperCase();
    const kunciRahasia = String(body.kunciRahasia ?? '').trim().toUpperCase();
    if (!nomorLaporan || !kunciRahasia) return jsonResponse({ error: 'Nomor Laporan dan Kunci Rahasia wajib diisi.' }, 400, corsHeaders);

    const { data: caseRow } = await admin.from('cases')
      .select('id, public_case_id, status, classification, submitted_at, closed_at, reporting_mode')
      .eq('public_case_id', nomorLaporan).eq('reporting_mode', 'ANONYMOUS').maybeSingle();
    if (!caseRow) return jsonResponse({ error: 'Nomor Laporan atau Kunci Rahasia tidak sesuai.' }, 403, corsHeaders);

    const { data: access } = await admin.from('case_anonymous_access')
      .select('secret_hash, failed_attempts, locked_until').eq('case_id', caseRow.id).single();
    if (!access) return jsonResponse({ error: 'Nomor Laporan atau Kunci Rahasia tidak sesuai.' }, 403, corsHeaders);
    if (access.locked_until && Date.parse(access.locked_until) > Date.now()) return jsonResponse({ error: 'Akses sementara dikunci karena terlalu banyak percobaan. Coba lagi beberapa saat lagi.' }, 429, corsHeaders);

    const suppliedHash = await sha256Base64(kunciRahasia);
    const valid = timingSafeEqual(new TextEncoder().encode(suppliedHash), new TextEncoder().encode(access.secret_hash));
    if (!valid) {
      const failed = Number(access.failed_attempts ?? 0) + 1;
      const lockedUntil = failed >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
      await admin.from('case_anonymous_access').update({ failed_attempts: failed >= 5 ? 0 : failed, locked_until: lockedUntil }).eq('case_id', caseRow.id);
      return jsonResponse({ error: 'Nomor Laporan atau Kunci Rahasia tidak sesuai.' }, 403, corsHeaders);
    }

    await admin.from('case_anonymous_access').update({ failed_attempts: 0, locked_until: null, last_used_at: new Date().toISOString() }).eq('case_id', caseRow.id);

    const [{ data: report }, { data: messages }, { data: closure }] = await Promise.all([
      admin.from('case_reports').select('title').eq('case_id', caseRow.id).single(),
      admin.from('case_messages').select('id, sender_type, body, created_at').eq('case_id', caseRow.id).eq('visible_to_reporter', true).order('created_at', { ascending: true }),
      admin.from('case_closures').select('reporter_summary, reporter_outcomes, created_at').eq('case_id', caseRow.id).maybeSingle(),
    ]);

    const outcomes = Array.isArray(closure?.reporter_outcomes) ? closure.reporter_outcomes : [];
    return jsonResponse({
      nomorLaporan: caseRow.public_case_id,
      judul: report?.title ?? 'Laporan',
      status: STATUS_LABELS[caseRow.status] ?? 'Sedang Ditangani',
      statusCode: caseRow.status,
      klasifikasi: caseRow.classification ? (CLASSIFICATION_LABELS[caseRow.classification] ?? null) : null,
      tanggalLaporan: caseRow.submitted_at,
      canReply: !['CLOSED', 'OUT_OF_SCOPE'].includes(caseRow.status),
      hasilAkhir: closure ? {
        ringkasan: closure.reporter_summary,
        waktu: closure.created_at,
        hasil: outcomes.map((item: any) => ({
          dugaan: Number(item.sequenceNo),
          hasil: OUTCOME_LABELS[String(item.outcome)] ?? String(item.outcome),
        })),
      } : null,
      pesan: (messages ?? []).map((message) => ({
        id: message.id,
        dari: message.sender_type === 'REPORTER' ? 'Anda' : message.sender_type === 'SYSTEM' ? 'Sistem' : 'Tim Penanganan',
        isi: message.body,
        waktu: message.created_at,
      })),
    }, 200, corsHeaders);
  } catch (error) {
    console.error('check-anonymous-report', error);
    return jsonResponse({ error: 'Perkembangan laporan belum dapat dimuat.' }, 400, corsHeaders);
  }
});
