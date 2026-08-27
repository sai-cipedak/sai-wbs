import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';
import { corsHeaders } from '../_shared/cors.ts';
import { generatePublicCaseId, jsonResponse, normalizeIntake, ORG_CODE, STATUS_LABELS } from '../_shared/intake.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identityProtection = 'Identitas Anda disimpan terpisah dan tersembunyi dari Tim Pemeriksa secara default.';

async function existingSubmission(userId: string, submissionToken: string) {
  const { data, error } = await admin.from('cases')
    .select('id, public_case_id, status, submitted_at')
    .eq('created_by_user_id', userId)
    .eq('submission_token', submissionToken)
    .eq('reporting_mode', 'IDENTIFIED')
    .maybeSingle();
  if (error) throw error;
  return data;
}

function existingResponse(row: any) {
  return jsonResponse({
    nomorLaporan: row.public_case_id,
    status: STATUS_LABELS[row.status] ?? row.status,
    submittedAt: row.submitted_at,
    identityProtection,
    duplicatePrevented: true,
  }, 200, corsHeaders);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Metode tidak diizinkan.' }, 405, corsHeaders);

  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return jsonResponse({ error: 'Silakan masuk terlebih dahulu.' }, 401, corsHeaders);

    const { data: userResult, error: userError } = await admin.auth.getUser(token);
    const user = userResult.user;
    if (userError || !user?.email) return jsonResponse({ error: 'Sesi tidak valid. Silakan masuk kembali.' }, 401, corsHeaders);

    const raw = await req.json() as Record<string, unknown>;
    const submissionToken = String(raw.submissionToken ?? '').trim();
    if (submissionToken && !UUID_RE.test(submissionToken)) return jsonResponse({ error: 'Token pengiriman tidak valid. Muat ulang halaman dan coba kembali.' }, 400, corsHeaders);
    const intake = normalizeIntake(raw);
    const email = user.email.trim().toLowerCase();

    if (submissionToken) {
      const existing = await existingSubmission(user.id, submissionToken);
      if (existing) return existingResponse(existing);
    }

    const { data: org, error: orgError } = await admin.from('organizations').select('id, active_policy_version_id').eq('code', ORG_CODE).eq('is_active', true).single();
    if (orgError || !org?.active_policy_version_id) throw new Error('Konfigurasi organisasi belum siap.');

    const { data: allowlist, error: allowError } = await admin.from('reporter_allowlist').select('email, member_type').eq('organization_id', org.id).eq('is_active', true);
    if (allowError) throw allowError;
    const membership = (allowlist ?? []).find((row) => String(row.email).trim().toLowerCase() === email);
    if (!membership) return jsonResponse({ error: 'Akun Google ini belum terdaftar sebagai OTS atau staf SAI Cipedak. Gunakan jalur tanpa identitas atau hubungi pengelola portal.' }, 403, corsHeaders);

    const displayName = String(user.user_metadata?.full_name ?? user.user_metadata?.name ?? email).slice(0, 200);
    const { data: existingProfile, error: existingProfileError } = await admin.from('profiles').select('user_id, organization_id, member_type, is_active').eq('user_id', user.id).maybeSingle();
    if (existingProfileError) throw existingProfileError;
    if (existingProfile && existingProfile.organization_id !== org.id) throw new Error('Profile akun berada pada organisasi berbeda.');
    const profileMemberType = existingProfile?.member_type === 'INTERNAL' ? 'INTERNAL' : membership.member_type;
    const profileIsActive = existingProfile ? existingProfile.is_active : true;
    const { error: profileError } = await admin.from('profiles').upsert({ user_id: user.id, organization_id: org.id, display_name: displayName, email, member_type: profileMemberType, is_active: profileIsActive, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    if (profileError) throw profileError;

    const safetyFastLane = intake.childSafetyRisk;
    const publicCaseId = generatePublicCaseId();
    const { data: createdCase, error: caseError } = await admin.from('cases').insert({
      organization_id: org.id,
      public_case_id: publicCaseId,
      reporting_mode: 'IDENTIFIED',
      status: safetyFastLane ? 'REFERRED_SAFEGUARDING' : 'SUBMITTED',
      classification: safetyFastLane ? 'SAFEGUARDING' : null,
      priority: safetyFastLane ? 'CRITICAL' : null,
      authority_code: safetyFastLane ? 'HSE' : 'TRIAGE',
      policy_version_id: org.active_policy_version_id,
      created_by_user_id: user.id,
      submission_token: submissionToken || null,
      is_test_data: false,
    }).select('id, submitted_at').single();

    if (caseError || !createdCase) {
      if (submissionToken && (caseError as any)?.code === '23505') {
        const existing = await existingSubmission(user.id, submissionToken);
        if (existing) return existingResponse(existing);
      }
      throw caseError ?? new Error('Gagal membuat laporan.');
    }

    const cleanup = async () => { await admin.from('cases').delete().eq('id', createdCase.id); };
    const { error: reportError } = await admin.from('case_reports').insert({ case_id: createdCase.id, title: intake.title, narrative: intake.narrative, incident_date: intake.incidentDate, incident_time_text: intake.incidentTimeText, location_text: intake.locationText, child_safety_risk: intake.childSafetyRisk, ongoing_risk: intake.ongoingRisk, people_involved_text: intake.peopleInvolvedText });
    if (reportError) { await cleanup(); throw reportError; }
    const { error: identityError } = await admin.from('case_reporter_identities').insert({ case_id: createdCase.id, user_id: user.id, reporter_name: displayName, reporter_email: email, visibility_status: 'HIDDEN' });
    if (identityError) { await cleanup(); throw identityError; }
    await admin.from('audit_logs').insert({ organization_id: org.id, case_id: createdCase.id, actor_user_id: user.id, event_type: 'CASE_SUBMITTED_IDENTIFIED', object_type: 'case', object_id: createdCase.id, details: { safety_fast_lane: safetyFastLane, profile_member_type_preserved: profileMemberType === 'INTERNAL', idempotency_enabled: !!submissionToken } });

    return jsonResponse({ nomorLaporan: publicCaseId, status: safetyFastLane ? 'Sedang Ditangani' : 'Laporan Diterima', submittedAt: createdCase.submitted_at, identityProtection, duplicatePrevented: false }, 201, corsHeaders);
  } catch (error) {
    console.error('submit-identified-report', error);
    const message = error instanceof Error && /^(Judul|Uraian|Format|Isian)/.test(error.message) ? error.message : 'Laporan belum dapat dikirim. Silakan coba kembali.';
    return jsonResponse({ error: message }, 400, corsHeaders);
  }
});
