import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';
import { corsHeaders } from '../_shared/cors.ts';
import { sha256Base64, timingSafeEqual } from '../_shared/intake.ts';
import {
  driveConfigured,
  ensureCaseEvidenceFolder,
  generateDriveFileId,
  getDriveFileContent,
  getDriveFileMetadata,
  startResumableDriveUpload,
  trashDriveFile,
  restoreDriveFile,
  verifyDriveRepository,
} from '../_shared/evidence-drive.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
});

const AUTHORITY_ROLES: Record<string, string[]> = {
  TRIAGE: ['TRIAGE', 'SECRETARIAT'],
  SECRETARIAT: ['SECRETARIAT'],
  DEKOM: ['DEKOM'],
  HSE: ['HSE'],
  GRIEVANCE: ['GRIEVANCE_COORDINATOR'],
};

const DEFAULT_POLICY = {
  provider: 'GOOGLE_DRIVE',
  direct_resumable_upload: true,
  public_links_allowed: false,
  max_file_size_bytes: 104857600,
  sha256_client_max_bytes: 26214400,
  max_active_files_per_case: 30,
  allowed_mime_types: [
    'application/pdf', 'text/plain',
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/webm',
    'video/mp4', 'video/quicktime', 'video/webm',
  ],
  reporter_default_access_scope: 'AUTHORITY_ONLY',
  reporter_default_review_state: 'PENDING_REVIEW',
};

type CaseRow = {
  id: string;
  organization_id: string;
  public_case_id: string;
  reporting_mode: string;
  status: string;
  authority_code: string;
  created_by_user_id: string | null;
  is_test_data: boolean;
};

type Access = {
  caseRow: CaseRow;
  actorContext: 'REPORTER' | 'INTERNAL';
  uploaderContext: 'ANONYMOUS_REPORTER' | 'IDENTIFIED_REPORTER' | 'INTERNAL';
  userId: string | null;
  internalKind: 'AUTHORITY' | 'ASSIGNEE' | null;
};

function cleanFilename(value: unknown) {
  const text = String(value ?? '').trim().replace(/\\/g, '/').split('/').pop() ?? '';
  if (!text || text.length > 255 || /[\u0000-\u001f]/.test(text)) return null;
  return text;
}

function storageFilename(original: string) {
  const match = original.match(/\.([A-Za-z0-9]{1,10})$/);
  return `${crypto.randomUUID()}${match ? `.${match[1].toLowerCase()}` : ''}`;
}

function evidenceType(mime: string) {
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('audio/')) return 'AUDIO';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime === 'application/pdf' || mime === 'text/plain' || mime.includes('word') || mime.includes('excel') || mime.includes('spreadsheet')) return 'DOCUMENT';
  return 'OTHER';
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function policyFor(organizationId: string) {
  const { data } = await admin.from('app_settings')
    .select('setting_value')
    .eq('organization_id', organizationId)
    .eq('setting_key', 'evidence_policy')
    .maybeSingle();
  return { ...DEFAULT_POLICY, ...((data?.setting_value ?? {}) as Record<string, unknown>) } as typeof DEFAULT_POLICY;
}

async function findCase(body: Record<string, unknown>) {
  const caseId = String(body.caseId ?? '').trim();
  const publicCaseId = String(body.nomorLaporan ?? body.publicCaseId ?? '').trim().toUpperCase();
  let query = admin.from('cases').select('id,organization_id,public_case_id,reporting_mode,status,authority_code,created_by_user_id,is_test_data');
  if (caseId) query = query.eq('id', caseId);
  else if (publicCaseId) query = query.eq('public_case_id', publicCaseId);
  else throw new Error('CASE_REQUIRED');
  const { data, error } = await query.maybeSingle();
  if (error || !data) throw new Error('CASE_NOT_FOUND');
  return data as CaseRow;
}

async function validateAnonymous(caseRow: CaseRow, secretValue: unknown) {
  if (caseRow.reporting_mode !== 'ANONYMOUS') throw new Error('ANONYMOUS_ACCESS_INVALID');
  const secret = String(secretValue ?? '').trim().toUpperCase();
  if (!secret) throw new Error('ANONYMOUS_ACCESS_INVALID');
  const { data: access } = await admin.from('case_anonymous_access')
    .select('secret_hash,failed_attempts,locked_until')
    .eq('case_id', caseRow.id)
    .single();
  if (!access) throw new Error('ANONYMOUS_ACCESS_INVALID');
  if (access.locked_until && Date.parse(access.locked_until) > Date.now()) throw new Error('ANONYMOUS_LOCKED');
  const hashed = await sha256Base64(secret);
  const valid = timingSafeEqual(new TextEncoder().encode(hashed), new TextEncoder().encode(access.secret_hash));
  if (!valid) {
    const failed = Number(access.failed_attempts ?? 0) + 1;
    const lockedUntil = failed >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    await admin.from('case_anonymous_access').update({ failed_attempts: failed >= 5 ? 0 : failed, locked_until: lockedUntil }).eq('case_id', caseRow.id);
    throw new Error('ANONYMOUS_ACCESS_INVALID');
  }
  await admin.from('case_anonymous_access').update({ failed_attempts: 0, locked_until: null, last_used_at: new Date().toISOString() }).eq('case_id', caseRow.id);
}

async function activeInternalAccess(userId: string, caseRow: CaseRow) {
  const nowIso = new Date().toISOString();
  const { data: profile } = await admin.from('profiles')
    .select('is_active')
    .eq('user_id', userId)
    .eq('organization_id', caseRow.organization_id)
    .maybeSingle();
  if (!profile?.is_active) return null;

  const { data: assignment } = await admin.from('case_assignments')
    .select('id')
    .eq('case_id', caseRow.id)
    .eq('user_id', userId)
    .eq('access_status', 'ACTIVE')
    .limit(1);
  if ((assignment ?? []).length) return 'ASSIGNEE' as const;

  const rolesNeeded = AUTHORITY_ROLES[caseRow.authority_code] ?? [];
  if (!rolesNeeded.length) return null;
  const { data: roles } = await admin.from('user_system_roles')
    .select('role_code,active_from,active_until')
    .eq('user_id', userId)
    .eq('organization_id', caseRow.organization_id)
    .in('role_code', rolesNeeded)
    .lte('active_from', nowIso);
  const active = (roles ?? []).some((r: any) => !r.active_until || r.active_until > nowIso);
  return active ? 'AUTHORITY' as const : null;
}

async function authorize(req: Request, body: Record<string, unknown>): Promise<Access> {
  const caseRow = await findCase(body);
  const anonymousSecret = body.kunciRahasia ?? body.anonymousSecret;
  if (anonymousSecret != null && String(anonymousSecret).trim()) {
    await validateAnonymous(caseRow, anonymousSecret);
    return { caseRow, actorContext: 'REPORTER', uploaderContext: 'ANONYMOUS_REPORTER', userId: null, internalKind: null };
  }

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('UNAUTHENTICATED');
  const { data: userData, error } = await admin.auth.getUser(token);
  const user = userData.user;
  if (error || !user) throw new Error('UNAUTHENTICATED');

  const requested = String(body.actorContext ?? '').toUpperCase();
  const internalKind = await activeInternalAccess(user.id, caseRow);
  const isReporter = caseRow.reporting_mode === 'IDENTIFIED' && caseRow.created_by_user_id === user.id;

  if (requested === 'REPORTER') {
    if (!isReporter) throw new Error('REPORTER_FORBIDDEN');
    return { caseRow, actorContext: 'REPORTER', uploaderContext: 'IDENTIFIED_REPORTER', userId: user.id, internalKind: null };
  }
  if (requested === 'INTERNAL') {
    if (!internalKind) throw new Error('INTERNAL_FORBIDDEN');
    return { caseRow, actorContext: 'INTERNAL', uploaderContext: 'INTERNAL', userId: user.id, internalKind };
  }
  if (internalKind && !isReporter) return { caseRow, actorContext: 'INTERNAL', uploaderContext: 'INTERNAL', userId: user.id, internalKind };
  if (isReporter && !internalKind) return { caseRow, actorContext: 'REPORTER', uploaderContext: 'IDENTIFIED_REPORTER', userId: user.id, internalKind: null };
  if (isReporter && internalKind) throw new Error('ACTOR_CONTEXT_REQUIRED');
  throw new Error('FORBIDDEN');
}

async function canDownload(access: Access, evidence: any) {
  if (evidence.status !== 'ACTIVE') return false;
  if (access.actorContext === 'REPORTER') {
    if (access.uploaderContext === 'ANONYMOUS_REPORTER') return evidence.uploader_context === 'ANONYMOUS_REPORTER';
    return evidence.uploader_context === 'IDENTIFIED_REPORTER' && evidence.uploaded_by_user_id === access.userId;
  }
  if (access.internalKind === 'AUTHORITY') return true;
  return access.internalKind === 'ASSIGNEE' && evidence.access_scope === 'INVESTIGATION_TEAM' && evidence.review_state === 'CLEARED';
}

async function recoverCompletedUploads(access: Access, policy: typeof DEFAULT_POLICY) {
  let query = admin.from('case_evidence_upload_sessions')
    .select('*')
    .eq('case_id', access.caseRow.id)
    .eq('status', 'INITIATED')
    .eq('uploader_context', access.uploaderContext)
    .gt('expires_at', new Date().toISOString())
    .limit(10);
  if (access.userId) query = query.eq('uploaded_by_user_id', access.userId);
  else query = query.is('uploaded_by_user_id', null);
  const { data: sessions } = await query;
  const hashMax = Number(policy.sha256_client_max_bytes ?? DEFAULT_POLICY.sha256_client_max_bytes);

  for (const session of sessions ?? []) {
    try {
      const meta = await getDriveFileMetadata(session.drive_file_id);
      const validMeta = meta.id === session.drive_file_id && !meta.trashed && meta.name === session.storage_filename && meta.mimeType === session.mime_type && Number(meta.size ?? -1) === Number(session.file_size_bytes) && Array.isArray(meta.parents) && meta.parents.includes(session.drive_folder_id) && meta.appProperties?.sai_evidence_session === session.id;
      if (!validMeta) continue;

      let verifiedHash: string | null = null;
      if (Number(session.file_size_bytes) <= hashMax) {
        const fileResponse = await getDriveFileContent(session.drive_file_id);
        const digest = await crypto.subtle.digest('SHA-256', await fileResponse.arrayBuffer());
        verifiedHash = hex(new Uint8Array(digest));
        if (!session.sha256_hash || verifiedHash !== String(session.sha256_hash).toLowerCase()) {
          await admin.from('case_evidence_upload_sessions').update({ status: 'FAILED', updated_at: new Date().toISOString() }).eq('id', session.id);
          continue;
        }
      }

      const { error: finalizeError } = await admin.rpc('finalize_evidence_upload_atomic', {
        p_session_id: session.id, p_case_id: access.caseRow.id, p_actor_user_id: access.userId,
        p_uploader_context: session.uploader_context, p_verified_hash: verifiedHash,
        p_evidence_type: evidenceType(session.mime_type), p_description: 'Recovered after verified browser upload.',
        p_recovered: true,
      });
      if (finalizeError) throw finalizeError;
    } catch (error) {
      console.error('Evidence upload recovery failed', session.id, error);
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Metode tidak diizinkan.' }, 405);

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action ?? 'POLICY').toUpperCase();

    if (action === 'POLICY') {
      const { data: org } = await admin.from('organizations').select('id').eq('code', 'SAI-CIPEDAK').single();
      if (!org) throw new Error('ORG_NOT_FOUND');
      const policy = await policyFor(org.id);
      let repository = { ready: false, privateAccessEnforced: false };
      if (driveConfigured()) {
        try { repository = await verifyDriveRepository(); }
        catch (error) { console.error('Drive repository verification failed', error); }
      }
      return json({
        policy: {
          provider: policy.provider,
          maxFileSizeBytes: policy.max_file_size_bytes,
          sha256VerifyMaxBytes: policy.sha256_client_max_bytes,
          maxActiveFilesPerCase: policy.max_active_files_per_case,
          allowedMimeTypes: policy.allowed_mime_types,
          publicLinksAllowed: policy.public_links_allowed,
        },
        uploadConfigured: driveConfigured(),
        repositoryReady: repository.ready,
        privateAccessEnforced: repository.privateAccessEnforced,
      });
    }

    const access = await authorize(req, body);
    const policy = await policyFor(access.caseRow.organization_id);

    if (action === 'LIST') {
      await recoverCompletedUploads(access, policy);
      let q = admin.from('case_evidence')
        .select('id,original_filename,mime_type,file_size_bytes,sha256_hash,evidence_type,description,uploader_context,status,access_scope,review_state,review_note,created_at,reviewed_at,uploaded_by_user_id')
        .eq('case_id', access.caseRow.id)
        .order('created_at', { ascending: true });
      if (access.actorContext === 'REPORTER') {
        q = q.eq('uploader_context', access.uploaderContext);
        if (access.userId) q = q.eq('uploaded_by_user_id', access.userId);
      } else if (access.internalKind === 'ASSIGNEE') {
        q = q.eq('status', 'ACTIVE').eq('access_scope', 'INVESTIGATION_TEAM').eq('review_state', 'CLEARED');
      }
      const { data, error } = await q;
      if (error) throw error;
      return json({
        evidence: data ?? [],
        canUpload: !['CLOSED', 'OUT_OF_SCOPE'].includes(access.caseRow.status),
        canReview: access.actorContext === 'INTERNAL' && access.internalKind === 'AUTHORITY',
        uploadConfigured: driveConfigured(),
        policy: { maxFileSizeBytes: policy.max_file_size_bytes, sha256VerifyMaxBytes: policy.sha256_client_max_bytes, allowedMimeTypes: policy.allowed_mime_types },
      });
    }

    if (action === 'INIT_UPLOAD') {
      if (['CLOSED', 'OUT_OF_SCOPE'].includes(access.caseRow.status)) return json({ error: 'Bukti baru tidak dapat ditambahkan setelah case ditutup.' }, 409);
      if (!driveConfigured()) return json({ error: 'Repositori Google Drive belum dikonfigurasi untuk portal.' }, 503);

      const originalFilename = cleanFilename(body.originalFilename);
      const mimeType = String(body.mimeType ?? '').trim().toLowerCase();
      const fileSizeBytes = Number(body.fileSizeBytes ?? 0);
      const maxSize = Number(policy.max_file_size_bytes ?? DEFAULT_POLICY.max_file_size_bytes);
      const hashMax = Number(policy.sha256_client_max_bytes ?? DEFAULT_POLICY.sha256_client_max_bytes);
      const allowed = Array.isArray(policy.allowed_mime_types) ? policy.allowed_mime_types.map(String) : DEFAULT_POLICY.allowed_mime_types;
      const sha256 = String(body.sha256Hash ?? '').trim().toLowerCase() || null;
      if (!originalFilename) return json({ error: 'Nama file tidak valid.' }, 400);
      if (!Number.isSafeInteger(fileSizeBytes) || fileSizeBytes <= 0 || fileSizeBytes > maxSize) return json({ error: `Ukuran file harus antara 1 byte dan ${Math.round(maxSize / 1048576)} MB.` }, 400);
      if (!allowed.includes(mimeType)) return json({ error: 'Tipe file belum diizinkan oleh kebijakan bukti.' }, 400);
      if (fileSizeBytes <= hashMax && (!sha256 || !/^[0-9a-f]{64}$/.test(sha256))) return json({ error: 'SHA-256 file wajib dihitung untuk file pada ukuran ini.' }, 400);
      if (fileSizeBytes > hashMax && sha256 && !/^[0-9a-f]{64}$/.test(sha256)) return json({ error: 'Format SHA-256 tidak valid.' }, 400);

      const [{ count: evidenceCount }, { count: sessionCount }] = await Promise.all([
        admin.from('case_evidence').select('id', { count: 'exact', head: true }).eq('case_id', access.caseRow.id).eq('status', 'ACTIVE'),
        admin.from('case_evidence_upload_sessions').select('id', { count: 'exact', head: true }).eq('case_id', access.caseRow.id).eq('status', 'INITIATED').gt('expires_at', new Date().toISOString()),
      ]);
      const maxFiles = Number(policy.max_active_files_per_case ?? DEFAULT_POLICY.max_active_files_per_case);
      if (Number(evidenceCount ?? 0) + Number(sessionCount ?? 0) >= maxFiles) return json({ error: `Batas maksimum ${maxFiles} file aktif per case telah tercapai.` }, 409);

      let accessScope = 'AUTHORITY_ONLY';
      let reviewState = 'PENDING_REVIEW';
      if (access.actorContext === 'INTERNAL') {
        reviewState = 'CLEARED';
        accessScope = access.internalKind === 'ASSIGNEE' ? 'INVESTIGATION_TEAM' : String(body.accessScope ?? 'AUTHORITY_ONLY').toUpperCase();
        if (!['AUTHORITY_ONLY', 'INVESTIGATION_TEAM'].includes(accessScope)) return json({ error: 'Scope akses bukti tidak valid.' }, 400);
      }

      const driveFolderId = await ensureCaseEvidenceFolder(admin, access.caseRow.id, access.userId);
      const driveFileId = await generateDriveFileId();
      const sessionId = crypto.randomUUID();
      const storedName = storageFilename(originalFilename);
      const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString();

      const { error: sessionError } = await admin.from('case_evidence_upload_sessions').insert({
        id: sessionId,
        case_id: access.caseRow.id,
        drive_file_id: driveFileId,
        drive_folder_id: driveFolderId,
        storage_filename: storedName,
        original_filename: originalFilename,
        mime_type: mimeType,
        file_size_bytes: fileSizeBytes,
        sha256_hash: fileSizeBytes <= hashMax ? sha256 : null,
        uploader_context: access.uploaderContext,
        uploaded_by_user_id: access.userId,
        access_scope: accessScope,
        review_state: reviewState,
        status: 'INITIATED',
        expires_at: expiresAt,
      });
      if (sessionError) throw sessionError;

      let uploadUrl: string;
      try {
        uploadUrl = await startResumableDriveUpload({
          sessionId,
          driveFileId,
          driveFolderId,
          storageFilename: storedName,
          mimeType,
          fileSizeBytes,
        });
      } catch (error) {
        await admin.from('case_evidence_upload_sessions').update({ status: 'FAILED', updated_at: new Date().toISOString() }).eq('id', sessionId);
        throw error;
      }

      await admin.from('audit_logs').insert({
        organization_id: access.caseRow.organization_id,
        case_id: access.caseRow.id,
        actor_user_id: access.userId,
        event_type: 'EVIDENCE_UPLOAD_INITIATED',
        object_type: 'case_evidence_upload_session',
        object_id: sessionId,
        details: { uploader_context: access.uploaderContext, access_scope: accessScope, mime_type: mimeType, file_size_bytes: fileSizeBytes },
      });
      return json({ sessionId, uploadUrl, expiresAt, fileSizeBytes, mimeType });
    }

    if (action === 'COMPLETE_UPLOAD') {
      const sessionId = String(body.sessionId ?? '').trim();
      if (!sessionId) return json({ error: 'Upload session wajib.' }, 400);
      const { data: session, error: sessionError } = await admin.from('case_evidence_upload_sessions').select('*').eq('id', sessionId).eq('case_id', access.caseRow.id).maybeSingle();
      if (sessionError || !session) return json({ error: 'Upload session tidak ditemukan.' }, 404);
      if (session.status === 'FINALIZED') {
        const { data: existing } = await admin.from('case_evidence').select('id').eq('drive_file_id', session.drive_file_id).maybeSingle();
        return json({ ok: true, evidenceId: existing?.id ?? null, alreadyFinalized: true });
      }
      if (session.status !== 'INITIATED') return json({ error: 'Upload session tidak lagi aktif.' }, 409);
      if (Date.parse(session.expires_at) <= Date.now()) {
        await admin.from('case_evidence_upload_sessions').update({ status: 'EXPIRED', updated_at: new Date().toISOString() }).eq('id', sessionId);
        return json({ error: 'Upload session sudah kedaluwarsa. Mulai upload kembali.' }, 410);
      }
      if (session.uploader_context !== access.uploaderContext || (session.uploaded_by_user_id ?? null) !== access.userId) return json({ error: 'Upload session bukan milik akses ini.' }, 403);

      const meta = await getDriveFileMetadata(session.drive_file_id);
      const validMeta = meta.id === session.drive_file_id && !meta.trashed && meta.name === session.storage_filename && meta.mimeType === session.mime_type && Number(meta.size ?? -1) === Number(session.file_size_bytes) && Array.isArray(meta.parents) && meta.parents.includes(session.drive_folder_id) && meta.appProperties?.sai_evidence_session === sessionId;
      if (!validMeta) {
        await admin.from('case_evidence_upload_sessions').update({ status: 'FAILED', updated_at: new Date().toISOString() }).eq('id', sessionId);
        return json({ error: 'Metadata file di Google Drive tidak sesuai dengan upload session.' }, 409);
      }

      const hashMax = Number(policy.sha256_client_max_bytes ?? DEFAULT_POLICY.sha256_client_max_bytes);
      let verifiedHash: string | null = null;
      if (Number(session.file_size_bytes) <= hashMax) {
        const fileResponse = await getDriveFileContent(session.drive_file_id);
        const digest = await crypto.subtle.digest('SHA-256', await fileResponse.arrayBuffer());
        verifiedHash = hex(new Uint8Array(digest));
        if (!session.sha256_hash || verifiedHash !== String(session.sha256_hash).toLowerCase()) {
          await admin.from('case_evidence_upload_sessions').update({ status: 'FAILED', updated_at: new Date().toISOString() }).eq('id', sessionId);
          return json({ error: 'Verifikasi integritas SHA-256 file gagal.' }, 409);
        }
      }

      const { data: finalized, error: finalizeError } = await admin.rpc('finalize_evidence_upload_atomic', {
        p_session_id: sessionId, p_case_id: access.caseRow.id, p_actor_user_id: access.userId,
        p_uploader_context: session.uploader_context, p_verified_hash: verifiedHash,
        p_evidence_type: evidenceType(session.mime_type),
        p_description: String(body.description ?? '').trim().slice(0, 2000) || null, p_recovered: false,
      });
      if (finalizeError) throw finalizeError;
      return json(finalized);
    }

    if (action === 'SET_REVIEW') {
      if (access.actorContext !== 'INTERNAL' || access.internalKind !== 'AUTHORITY') return json({ error: 'Hanya otoritas case yang dapat mereview scope bukti.' }, 403);
      if (['CLOSED', 'OUT_OF_SCOPE'].includes(access.caseRow.status)) return json({ error: 'Scope bukti tidak dapat diubah setelah case ditutup.' }, 409);
      const evidenceId = String(body.evidenceId ?? '').trim();
      const reviewState = String(body.reviewState ?? '').toUpperCase();
      let accessScope = String(body.accessScope ?? 'AUTHORITY_ONLY').toUpperCase();
      const note = String(body.reviewNote ?? '').trim().slice(0, 2000) || null;
      if (!evidenceId || !['CLEARED', 'RESTRICTED'].includes(reviewState)) return json({ error: 'Review state tidak valid.' }, 400);
      if (!['AUTHORITY_ONLY', 'INVESTIGATION_TEAM'].includes(accessScope)) return json({ error: 'Scope akses tidak valid.' }, 400);
      if (reviewState === 'RESTRICTED') accessScope = 'AUTHORITY_ONLY';
      if (reviewState === 'RESTRICTED' && (!note || note.length < 5)) return json({ error: 'Alasan pembatasan bukti wajib diisi.' }, 400);
      const { data, error } = await admin.rpc('review_evidence_atomic', { p_case_id: access.caseRow.id, p_evidence_id: evidenceId, p_actor_user_id: access.userId, p_review_state: reviewState, p_access_scope: accessScope, p_note: note });
      if (error) { const m=String(error.message??''); if(m.includes('EVIDENCE_NOT_FOUND'))return json({error:'Bukti tidak ditemukan.'},404); if(m.includes('EVIDENCE_INACTIVE'))return json({error:'Bukti nonaktif tidak dapat direview.'},409); throw error; }
      return json(data);
    }

    if (action === 'QUARANTINE') {
      if (access.actorContext !== 'INTERNAL' || access.internalKind !== 'AUTHORITY') return json({ error: 'Hanya otoritas case yang dapat mengarantina bukti.' }, 403);
      const evidenceId = String(body.evidenceId ?? '').trim();
      const note = String(body.reviewNote ?? '').trim().slice(0, 2000);
      if (!evidenceId || note.length < 5) return json({ error: 'Alasan karantina wajib diisi.' }, 400);
      const { data, error } = await admin.rpc('quarantine_evidence_atomic', { p_case_id: access.caseRow.id, p_evidence_id: evidenceId, p_actor_user_id: access.userId, p_note: note });
      if(error){if(String(error.message??'').includes('EVIDENCE_NOT_FOUND'))return json({error:'Bukti tidak ditemukan.'},404);throw error;} return json(data);
    }

    if (action === 'REMOVE') {
      if (access.actorContext !== 'INTERNAL' || access.internalKind !== 'AUTHORITY') return json({ error: 'Hanya otoritas case yang dapat menghapus bukti.' }, 403);
      const evidenceId = String(body.evidenceId ?? '').trim();
      const note = String(body.removalNote ?? '').trim().slice(0, 2000);
      if (!evidenceId || note.length < 5) return json({ error: 'Alasan penghapusan wajib diisi.' }, 400);
      const { data: ev, error } = await admin.from('case_evidence').select('id,drive_file_id,status,mime_type,file_size_bytes').eq('id', evidenceId).eq('case_id', access.caseRow.id).maybeSingle();
      if (error || !ev) return json({ error: 'Bukti tidak ditemukan.' }, 404);
      if (ev.status === 'REMOVED') return json({ ok: true, evidenceId, status: 'REMOVED', alreadyRemoved: true });
      if (!driveConfigured()) return json({ error: 'Repositori Google Drive belum dikonfigurasi untuk portal.' }, 503);
      await trashDriveFile(ev.drive_file_id);
      const { data, error: removeError } = await admin.rpc('mark_evidence_removed_atomic', { p_case_id: access.caseRow.id, p_evidence_id: evidenceId, p_actor_user_id: access.userId, p_note: note });
      if(removeError){
        try { await restoreDriveFile(ev.drive_file_id); }
        catch (restoreError) { console.error('Evidence removal compensation failed', evidenceId, restoreError); }
        throw removeError;
      }
      return json(data);
    }

    if (action === 'DOWNLOAD') {
      const evidenceId = String(body.evidenceId ?? '').trim();
      if (!evidenceId) return json({ error: 'Bukti wajib dipilih.' }, 400);
      const { data: ev, error } = await admin.from('case_evidence').select('*').eq('id', evidenceId).eq('case_id', access.caseRow.id).maybeSingle();
      if (error || !ev) return json({ error: 'Bukti tidak ditemukan.' }, 404);
      if (!(await canDownload(access, ev))) return json({ error: 'Akses ke file bukti tidak diizinkan.' }, 403);
      if (!driveConfigured()) return json({ error: 'Repositori Google Drive belum dikonfigurasi untuk portal.' }, 503);
      const fileResponse = await getDriveFileContent(ev.drive_file_id);
      const headers = new Headers(corsHeaders);
      headers.set('Content-Type', ev.mime_type || 'application/octet-stream');
      if (fileResponse.headers.get('Content-Length')) headers.set('Content-Length', fileResponse.headers.get('Content-Length')!);
      headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(ev.original_filename)}`);
      headers.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
      await admin.from('audit_logs').insert({
        organization_id: access.caseRow.organization_id,
        case_id: access.caseRow.id,
        actor_user_id: access.userId,
        event_type: 'EVIDENCE_ACCESSED',
        object_type: 'case_evidence',
        object_id: evidenceId,
        details: { actor_context: access.actorContext, internal_kind: access.internalKind, mime_type: ev.mime_type, file_size_bytes: ev.file_size_bytes },
      });
      return new Response(fileResponse.body, { status: 200, headers });
    }

    return json({ error: 'Aksi bukti tidak dikenali.' }, 400);
  } catch (error) {
    console.error('evidence-action', error);
    const message = error instanceof Error ? error.message : '';
    if (message === 'UNAUTHENTICATED') return json({ error: 'Silakan masuk terlebih dahulu.' }, 401);
    if (message === 'ANONYMOUS_ACCESS_INVALID') return json({ error: 'Nomor Laporan atau Kunci Rahasia tidak sesuai.' }, 403);
    if (message === 'ANONYMOUS_LOCKED') return json({ error: 'Akses sementara dikunci karena terlalu banyak percobaan.' }, 429);
    if (['REPORTER_FORBIDDEN', 'INTERNAL_FORBIDDEN', 'FORBIDDEN'].includes(message)) return json({ error: 'Akun ini tidak memiliki akses ke bukti case tersebut.' }, 403);
    if (message === 'ACTOR_CONTEXT_REQUIRED') return json({ error: 'Pilih konteks akses: pelapor atau internal.' }, 409);
    if (message === 'CASE_REQUIRED') return json({ error: 'Case wajib dipilih.' }, 400);
    if (message === 'CASE_NOT_FOUND') return json({ error: 'Case tidak ditemukan.' }, 404);
    if (message === 'DRIVE_NOT_CONFIGURED') return json({ error: 'Repositori Google Drive belum dikonfigurasi untuk portal.' }, 503);
    if (message.startsWith('DRIVE_')) return json({ error: 'Google Drive belum dapat memproses file bukti.' }, 502);
    return json({ error: 'Aksi bukti belum dapat diproses.' }, 400);
  }
});
