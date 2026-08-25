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
} from '../_shared/intake.ts';

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

    const safetyFastLane = intake.childSafetyRisk;
    const publicCaseId = generatePublicCaseId();
    const secretKey = generateSecretKey();
    const secretHash = await sha256Base64(secretKey);

    const { data: createdCase, error: caseError } = await admin
      .from('cases')
      .insert({
        organization_id: org.id,
        public_case_id: publicCaseId,
        reporting_mode: 'ANONYMOUS',
        status: safetyFastLane ? 'REFERRED_SAFEGUARDING' : 'SUBMITTED',
        classification: safetyFastLane ? 'SAFEGUARDING' : null,
        priority: safetyFastLane ? 'CRITICAL' : null,
        authority_code: safetyFastLane ? 'HSE' : 'TRIAGE',
        policy_version_id: org.active_policy_version_id,
      })
      .select('id, submitted_at, status')
      .single();
    if (caseError || !createdCase) throw caseError ?? new Error('Gagal membuat laporan.');

    const cleanup = async () => { await admin.from('cases').delete().eq('id', createdCase.id); };

    const { error: reportError } = await admin.from('case_reports').insert({
      case_id: createdCase.id,
      title: intake.title,
      narrative: intake.narrative,
      incident_date: intake.incidentDate,
      incident_time_text: intake.incidentTimeText,
      location_text: intake.locationText,
      child_safety_risk: intake.childSafetyRisk,
      ongoing_risk: intake.ongoingRisk,
      people_involved_text: intake.peopleInvolvedText,
    });
    if (reportError) { await cleanup(); throw reportError; }

    const { error: accessError } = await admin.from('case_anonymous_access').insert({
      case_id: createdCase.id,
      secret_hash: secretHash,
    });
    if (accessError) { await cleanup(); throw accessError; }

    await admin.from('audit_logs').insert({
      organization_id: org.id,
      case_id: createdCase.id,
      event_type: 'CASE_SUBMITTED_ANONYMOUS',
      object_type: 'case',
      object_id: createdCase.id,
      details: { safety_fast_lane: safetyFastLane },
    });

    return jsonResponse({
      nomorLaporan: publicCaseId,
      kunciRahasia: secretKey,
      status: safetyFastLane ? 'Sedang Ditangani' : 'Laporan Diterima',
      submittedAt: createdCase.submitted_at,
      reminder: 'Simpan Nomor Laporan dan Kunci Rahasia. Kunci Rahasia tidak dapat ditampilkan kembali.',
    }, 201, corsHeaders);
  } catch (error) {
    console.error('submit-anonymous-report', error);
    const message = error instanceof Error && /^(Judul|Uraian|Format|Isian)/.test(error.message)
      ? error.message
      : 'Laporan belum dapat dikirim. Silakan coba kembali.';
    return jsonResponse({ error: message }, 400, corsHeaders);
  }
});
