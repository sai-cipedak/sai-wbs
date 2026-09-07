import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';
import { corsHeaders } from '../_shared/cors.ts';
import { jsonResponse, ORG_CODE, verifyPbkdf2 } from '../_shared/intake.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const CONSENT_VERSION = 'reporter-profile-v1-2026-09';

type ChildInput = { name: string; classOrCohort: string };

async function currentUser(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('UNAUTHENTICATED');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user?.email) throw new Error('UNAUTHENTICATED');
  return data.user;
}

async function organization() {
  const { data, error } = await admin.from('organizations').select('id').eq('code', ORG_CODE).eq('is_active', true).single();
  if (error || !data) throw new Error('ORG_NOT_FOUND');
  return data;
}

function normalizeChildren(value: unknown): ChildInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new Error('INVALID_CHILDREN');
  return value.map((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const name = String(row.name ?? '').trim();
    const classOrCohort = String(row.classOrCohort ?? '').trim();
    if (name.length < 2 || name.length > 160 || classOrCohort.length < 1 || classOrCohort.length > 100) {
      throw new Error('INVALID_CHILDREN');
    }
    return { name, classOrCohort };
  });
}

function normalizeProfile(body: Record<string, unknown>) {
  const displayName = String(body.displayName ?? '').trim();
  const phone = String(body.phone ?? '').trim();
  if (displayName.length < 2 || displayName.length > 200) throw new Error('INVALID_NAME');
  if (phone.length < 8 || phone.length > 32 || !/^[0-9+() .-]+$/.test(phone)) throw new Error('INVALID_PHONE');
  return { displayName, phone, children: normalizeChildren(body.children) };
}

function currentAcademicYear() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', year: 'numeric', month: 'numeric' }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const start = month >= 7 ? year : year - 1;
  return `${start}/${start + 1}`;
}

async function accessContext(userId: string, email: string, orgId: string) {
  const nowIso = new Date().toISOString();
  const [{ data: profile, error: profileError }, { data: reporter, error: reporterError }, { data: children, error: childrenError }, { data: allowlist, error: allowlistError }, { data: roleRows, error: roleError }, { data: pending, error: pendingError }] = await Promise.all([
    admin.from('profiles').select('user_id,organization_id,display_name,email,member_type,is_active').eq('user_id', userId).maybeSingle(),
    admin.from('reporter_profiles').select('phone,onboarding_status,verification_status,reporting_status,academic_year,eligibility_expires_at,consent_at,updated_at').eq('user_id', userId).eq('organization_id', orgId).maybeSingle(),
    admin.from('reporter_children').select('id,child_name,class_or_cohort,academic_year').eq('user_id', userId).eq('organization_id', orgId).eq('is_active', true).order('created_at'),
    admin.from('reporter_allowlist').select('member_type').eq('organization_id', orgId).eq('email', email).eq('is_active', true).maybeSingle(),
    admin.from('user_system_roles').select('role_code,active_from,active_until').eq('user_id', userId).eq('organization_id', orgId).lte('active_from', nowIso),
    admin.from('pending_system_role_grants').select('id').eq('organization_id', orgId).eq('email', email).eq('status', 'PENDING').lte('active_from', nowIso).gt('claim_until', nowIso).limit(1),
  ]);
  const error = profileError || reporterError || childrenError || allowlistError || roleError || pendingError;
  if (error) throw error;
  if (profile && profile.organization_id !== orgId) throw new Error('PROFILE_ORG_MISMATCH');
  const now = Date.now();
  const hasInternalRole = (roleRows ?? []).some((role) => !role.active_until || Date.parse(role.active_until) > now);
  const internalAccess = Boolean(profile?.is_active && hasInternalRole);
  const accountInactive = Boolean(profile && !profile.is_active);
  const suspended = reporter?.reporting_status === 'SUSPENDED';
  const expired = Boolean(reporter && (reporter.reporting_status === 'EXPIRED' || Date.parse(reporter.eligibility_expires_at) <= now));
  const reporterActive = Boolean(reporter?.onboarding_status === 'COMPLETE' && reporter.reporting_status === 'ACTIVE' && !expired);
  const internalInvitationPending = Boolean(!profile && (pending?.length ?? 0) > 0);
  const onboardingRequired = !accountInactive && !internalAccess && !suspended && !internalInvitationPending && (!reporter || expired);
  return {
    email,
    internalAccess,
    internalInvitationPending,
    accountInactive,
    onboardingRequired,
    canSubmitIdentified: internalAccess || (!accountInactive && reporterActive),
    legacyEligible: Boolean(allowlist),
    academicYear: currentAcademicYear(),
    profile: profile ? { displayName: profile.display_name, memberType: profile.member_type } : null,
    reporterProfile: reporter ? {
      phone: reporter.phone,
      verificationStatus: reporter.verification_status,
      reportingStatus: suspended ? 'SUSPENDED' : expired ? 'EXPIRED' : reporter.reporting_status,
      academicYear: reporter.academic_year,
      eligibilityExpiresAt: reporter.eligibility_expires_at,
      consentAt: reporter.consent_at,
      updatedAt: reporter.updated_at,
    } : null,
    children: (children ?? []).map((child) => ({ id: child.id, name: child.child_name, classOrCohort: child.class_or_cohort, academicYear: child.academic_year })),
  };
}

async function matchingCode(codeValue: string, orgId: string) {
  const { data, error } = await admin.from('community_access_codes')
    .select('id,salt_b64,iterations,hash_b64,valid_from,valid_until')
    .eq('organization_id', orgId).eq('is_active', true);
  if (error) throw error;
  const now = Date.now();
  for (const code of data ?? []) {
    const starts = Date.parse(code.valid_from);
    const ends = code.valid_until ? Date.parse(code.valid_until) : Number.POSITIVE_INFINITY;
    if (starts <= now && now < ends && await verifyPbkdf2(codeValue, code.salt_b64, code.iterations, code.hash_b64)) return code;
  }
  return null;
}

function rpcError(error: { message?: string } | null) {
  const message = String(error?.message ?? '');
  if (message.includes('REPORTER_SUSPENDED')) return ['Akses membuat laporan baru sedang ditangguhkan oleh admin.', 403] as const;
  if (message.includes('PROFILE_INACTIVE')) return ['Akun ini dinonaktifkan. Hubungi pengelola portal.', 403] as const;
  if (message.includes('INTERNAL_PROFILE')) return ['Akun internal tidak memerlukan profile OTS.', 409] as const;
  if (message.includes('ACCESS_CODE_INACTIVE') || message.includes('ALLOWLIST_INACTIVE')) return ['Verifikasi akses sudah tidak berlaku. Muat ulang dan coba kembali.', 409] as const;
  if (message.includes('INVALID_ACADEMIC_YEAR')) return ['Tahun ajaran tidak sesuai dengan periode aktif.', 400] as const;
  if (message.includes('PROFILE_ORG_MISMATCH')) return ['Profile akun berada pada organisasi berbeda.', 409] as const;
  return ['Profile belum dapat disimpan. Periksa isian dan coba kembali.', 400] as const;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Metode tidak diizinkan.' }, 405, corsHeaders);
  try {
    const user = await currentUser(req);
    const org = await organization();
    const email = user.email!.trim().toLowerCase();
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action ?? 'STATUS').toUpperCase();
    const context = await accessContext(user.id, email, org.id);

    if (action === 'STATUS') return jsonResponse(context, 200, corsHeaders);
    if (context.internalAccess || context.internalInvitationPending) {
      return jsonResponse({ error: 'Akun internal tidak menggunakan onboarding OTS.' }, 409, corsHeaders);
    }
    if (context.accountInactive) return jsonResponse({ error: 'Akun ini dinonaktifkan. Hubungi pengelola portal.' }, 403, corsHeaders);
    const input = normalizeProfile(body);

    if (action === 'UPDATE') {
      if (!context.reporterProfile) return jsonResponse({ error: 'Lengkapi verifikasi profile terlebih dahulu.' }, 409, corsHeaders);
      const { data, error } = await admin.rpc('update_reporter_profile_atomic', {
        p_user_id: user.id, p_organization_id: org.id, p_email: email,
        p_display_name: input.displayName, p_phone: input.phone, p_children: input.children,
      });
      if (error) { const [message, status] = rpcError(error); return jsonResponse({ error: message }, status, corsHeaders); }
      return jsonResponse({ ...data, status: await accessContext(user.id, email, org.id) }, 200, corsHeaders);
    }

    if (action !== 'COMPLETE') return jsonResponse({ error: 'Aksi tidak dikenali.' }, 400, corsHeaders);
    if (body.consent !== true) return jsonResponse({ error: 'Persetujuan pengelolaan data wajib diberikan.' }, 400, corsHeaders);
    let verificationStatus = 'LEGACY_ALLOWLIST';
    let accessCodeId: string | null = null;
    if (!context.legacyEligible) {
      const supplied = String(body.communityAccessCode ?? '').trim().toUpperCase();
      if (!supplied) return jsonResponse({ error: 'Kode Akses Komunitas wajib diisi.' }, 400, corsHeaders);
      const code = await matchingCode(supplied, org.id);
      if (!code) return jsonResponse({ error: 'Kode Akses Komunitas tidak valid atau sudah kedaluwarsa.' }, 403, corsHeaders);
      verificationStatus = 'COMMUNITY_CODE';
      accessCodeId = code.id;
    }
    const displayName = input.displayName || String(user.user_metadata?.full_name ?? user.user_metadata?.name ?? email).slice(0, 200);
    const { data, error } = await admin.rpc('complete_reporter_onboarding_v2_atomic', {
      p_user_id: user.id, p_organization_id: org.id, p_email: email,
      p_display_name: displayName, p_phone: input.phone, p_academic_year: currentAcademicYear(),
      p_children: input.children, p_verification_status: verificationStatus,
      p_community_access_code_id: accessCodeId, p_consent_version: CONSENT_VERSION,
    });
    if (error) { const [message, status] = rpcError(error); return jsonResponse({ error: message }, status, corsHeaders); }
    return jsonResponse({ ...data, status: await accessContext(user.id, email, org.id) }, 200, corsHeaders);
  } catch (error) {
    console.error('reporter-profile', error);
    const message = error instanceof Error ? error.message : '';
    if (message === 'UNAUTHENTICATED') return jsonResponse({ error: 'Silakan masuk terlebih dahulu.' }, 401, corsHeaders);
    if (message === 'INVALID_NAME') return jsonResponse({ error: 'Nama OTS harus 2–200 karakter.' }, 400, corsHeaders);
    if (message === 'INVALID_PHONE') return jsonResponse({ error: 'Nomor kontak tidak valid.' }, 400, corsHeaders);
    if (message === 'INVALID_CHILDREN') return jsonResponse({ error: 'Isi 1–10 data anak dengan nama dan kelas/angkatan yang valid.' }, 400, corsHeaders);
    if (message === 'PROFILE_ORG_MISMATCH') return jsonResponse({ error: 'Profile akun berada pada organisasi berbeda.' }, 409, corsHeaders);
    return jsonResponse({ error: 'Profile reporter belum dapat diproses. Silakan coba kembali.' }, 400, corsHeaders);
  }
});
