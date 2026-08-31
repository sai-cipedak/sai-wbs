import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';
import { corsHeaders } from '../_shared/cors.ts';
import {
  generatePublicCaseId,
  generateSecretKey,
  jsonResponse,
  normalizeIntake,
  ORG_CODE,
  sha256Base64,
  verifyPbkdf2,
  STATUS_LABELS,
} from '../_shared/intake.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET_RE = /^WBS-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;

async function existingSubmission(submissionToken: string, secretKey: string) {
  const { data: existing, error } = await admin.from('cases')
    .select('id,public_case_id,status,submitted_at')
    .eq('submission_token', submissionToken)
    .eq('reporting_mode', 'ANONYMOUS')
    .maybeSingle();
  if (error) throw error;
  if (!existing) return null;

  const { data: access, error: accessError } = await admin.from('case_anonymous_access')
    .select('secret_hash')
    .eq('case_id', existing.id)
    .maybeSingle();
  if (accessError) throw accessError;
  if (!access?.secret_hash) throw new Error('IDEMPOTENCY_MISMATCH');
  const candidateHash = await sha256Base64(secretKey);
  if (candidateHash !== access.secret_hash) throw new Error('IDEMPOTENCY_MISMATCH');
  return existing;
}

function existingResponse(row: any, secretKey: string) {
  return jsonResponse({
    nomorLaporan: row.public_case_id,
    kunciRahasia: secretKey,
    status: STATUS_LABELS[row.status] ?? row.status,
    submittedAt: row.submitted_at,
    reminder: 'Simpan Nomor Laporan dan Kunci Rahasia. Kunci Rahasia tidak dapat ditampilkan kembali.',
    duplicatePrevented: true,
  }, 200, corsHeaders);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Metode tidak diizinkan.' }, 405, corsHeaders);

  try {
    const body = await req.json() as Record<string, unknown>;
    const submissionToken = String(body.submissionToken ?? '').trim();
    const suppliedSecret = String(body.anonymousSecret ?? '').trim().toUpperCase();
    if (submissionToken && !UUID_RE.test(submissionToken)) {
      return jsonResponse({ error: 'Token pengiriman tidak valid. Muat ulang halaman dan coba kembali.' }, 400, corsHeaders);
    }
    if (submissionToken && !SECRET_RE.test(suppliedSecret)) {
      return jsonResponse({ error: 'Kunci pengiriman anonim tidak valid. Muat ulang halaman dan coba kembali.' }, 400, corsHeaders);
    }

    const communityAccessCode = String(body.communityAccessCode ?? '').trim().toUpperCase();
    if (!communityAccessCode) return jsonResponse({ error: 'Kode Akses Komunitas wajib diisi.' }, 400, corsHeaders);

    const intake = normalizeIntake(body);
    const { data: org, error: orgError } = await admin
      .from('organizations')
      .select('id, active_policy_version_id')
      .eq('code', ORG_CODE)
      .eq('is_active', true)
      .single();
    if (orgError || !org?.active_policy_version_id) throw new Error('Konfigurasi organisasi belum siap.');

    const { data: codes, error: codeError } = await admin
      .from('community_access_codes')
      .select('salt_b64, iterations, hash_b64, valid_from, valid_until')
      .eq('organization_id', org.id)
      .eq('is_active', true);
    if (codeError) throw codeError;

    const now = Date.now();
    let accessGranted = false;
    for (const code of codes ?? []) {
      const starts = Date.parse(code.valid_from);
      const ends = code.valid_until ? Date.parse(code.valid_until) : Number.POSITIVE_INFINITY;
      if (starts <= now && now < ends && await verifyPbkdf2(communityAccessCode, code.salt_b64, code.iterations, code.hash_b64)) {
        accessGranted = true;
        break;
      }
    }
    if (!accessGranted) return jsonResponse({ error: 'Kode Akses Komunitas tidak valid.' }, 403, corsHeaders);

    const secretKey = submissionToken ? suppliedSecret : generateSecretKey();
    if (submissionToken) {
      const existing = await existingSubmission(submissionToken, secretKey);
      if (existing) return existingResponse(existing, secretKey);
    }

    const safetyFastLane = intake.childSafetyRisk;
    const publicCaseId = generatePublicCaseId();
    const secretHash = await sha256Base64(secretKey);

    const { data: created, error: createError } = await admin.rpc('create_anonymous_submission_atomic', {
      p_organization_id: org.id,
      p_policy_version_id: org.active_policy_version_id,
      p_public_case_id: publicCaseId,
      p_submission_token: submissionToken || null,
      p_secret_hash: secretHash,
      p_intake: intake,
      p_safety_fast_lane: safetyFastLane,
      p_idempotency_enabled: !!submissionToken,
    });

    if (createError || !created) {
      if (submissionToken && (createError as any)?.code === '23505') {
        const existing = await existingSubmission(submissionToken, secretKey);
        if (existing) return existingResponse(existing, secretKey);
      }
      throw createError ?? new Error('Gagal membuat laporan.');
    }

    return jsonResponse({
      nomorLaporan: created.publicCaseId ?? publicCaseId,
      kunciRahasia: secretKey,
      status: safetyFastLane ? 'Sedang Ditangani' : 'Laporan Diterima',
      submittedAt: created.submittedAt,
      reminder: 'Simpan Nomor Laporan dan Kunci Rahasia. Kunci Rahasia tidak dapat ditampilkan kembali.',
      duplicatePrevented: false,
    }, 201, corsHeaders);
  } catch (error) {
    console.error('submit-anonymous-report', error);
    if (error instanceof Error && error.message === 'IDEMPOTENCY_MISMATCH') {
      return jsonResponse({ error: 'Pengiriman anonim ini tidak cocok dengan attempt sebelumnya. Muat ulang halaman sebelum mencoba kembali.' }, 409, corsHeaders);
    }
    const message = error instanceof Error && /^(Judul|Uraian|Format|Isian)/.test(error.message)
      ? error.message
      : 'Laporan belum dapat dikirim. Silakan coba kembali.';
    return jsonResponse({ error: message }, 400, corsHeaders);
  }
});
