import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
});

async function requireUser(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('UNAUTHENTICATED');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Error('UNAUTHENTICATED');
  return data.user;
}
async function requireSecretariat(userId: string) {
  const now = new Date().toISOString();
  const { data, error } = await admin.from('user_system_roles')
    .select('organization_id, active_from, active_until')
    .eq('user_id', userId).eq('role_code', 'SECRETARIAT').lte('active_from', now);
  if (error) throw error;
  const role = (data ?? []).find((row) => !row.active_until || row.active_until > now);
  if (!role) throw new Error('FORBIDDEN');
  return role.organization_id as string;
}
async function getCase(caseId: string, orgId: string) {
  const { data, error } = await admin.from('cases')
    .select('id, public_case_id, reporting_mode, status, classification, authority_code, submitted_at, updated_at')
    .eq('id', caseId).eq('organization_id', orgId).eq('authority_code', 'SECRETARIAT').single();
  if (error || !data) throw new Error('CASE_NOT_FOUND');
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Metode tidak diizinkan.' }, 405);
  try {
    const user = await requireUser(req);
    const orgId = await requireSecretariat(user.id);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? 'LIST');

    if (action === 'LIST') {
      const { data: cases, error } = await admin.from('cases')
        .select('id, public_case_id, reporting_mode, status, classification, authority_code, submitted_at')
        .eq('organization_id', orgId).eq('authority_code', 'SECRETARIAT')
        .neq('status', 'CLOSED').neq('status', 'OUT_OF_SCOPE')
        .order('submitted_at', { ascending: false });
      if (error) throw error;
      const ids = (cases ?? []).map((c) => c.id);
      const { data: reports } = ids.length
        ? await admin.from('case_reports').select('case_id,title').in('case_id', ids)
        : { data: [] } as any;
      const titleMap = new Map((reports ?? []).map((r: any) => [r.case_id, r.title]));
      return json({ cases: (cases ?? []).map((c) => ({ ...c, title: titleMap.get(c.id) ?? c.public_case_id })) });
    }

    const caseId = String(body.caseId ?? '');
    if (!caseId) return json({ error: 'Case ID wajib.' }, 400);
    const caseRow = await getCase(caseId, orgId);

    if (action === 'DETAIL') {
      const results = await Promise.all([
        admin.from('case_reports').select('*').eq('case_id', caseId).single(),
        admin.from('case_messages').select('id,sender_type,body,visible_to_reporter,created_at').eq('case_id', caseId).order('created_at'),
        admin.from('case_team_members').select('id,email,display_name,member_category,committee_role,nomination_status,linked_user_id,nominated_at,declaration_at').eq('case_id', caseId).neq('nomination_status', 'REVOKED').order('nominated_at'),
        admin.from('case_assignments').select('user_id,assignment_role,access_status').eq('case_id', caseId),
        admin.from('case_allegations').select('id,sequence_no,statement,status').eq('case_id', caseId).eq('status', 'ACTIVE').order('sequence_no'),
        admin.from('case_findings').select('id,allegation_id,finding_status,analysis_text,recommendation_text,updated_at').eq('case_id', caseId),
        admin.from('case_authority_reviews').select('id,decision,review_notes,created_at').eq('case_id', caseId).order('created_at', { ascending: false }),
        admin.from('case_remediation_actions').select('id,action_text,owner_text,due_date,status,completion_note,created_at,updated_at,completed_at').eq('case_id', caseId).order('created_at'),
      ]);
      const [report, messages, team, assignments, allegations, findings, reviews, remediation] = results.map((r) => r.data);
      const accessMap = new Map((assignments ?? []).map((a: any) => [`${a.user_id}|${a.assignment_role}`, a.access_status]));
      return json({
        case: caseRow,
        report,
        messages: messages ?? [],
        team: (team ?? []).map((m: any) => ({
          ...m,
          assignment_status: m.linked_user_id ? (accessMap.get(`${m.linked_user_id}|${m.committee_role}`) ?? null) : null,
        })),
        allegations: allegations ?? [],
        findings: findings ?? [],
        reviews: reviews ?? [],
        remediation: remediation ?? [],
      });
    }

    if (action === 'REVIEW_FINDINGS') {
      if (caseRow.status !== 'AUTHORITY_REVIEW') return json({ error: 'Hasil pemeriksaan belum berada pada tahap review Sekretariat.' }, 409);
      const decision = String(body.decision ?? '');
      const notes = String(body.reviewNotes ?? '').trim();
      if (!['APPROVED', 'RETURNED_FOR_REVISION'].includes(decision) || notes.length < 5) return json({ error: 'Keputusan dan catatan review wajib diisi.' }, 400);
      const [{ data: allegations }, { data: findings }] = await Promise.all([
        admin.from('case_allegations').select('id').eq('case_id', caseId).eq('status', 'ACTIVE'),
        admin.from('case_findings').select('allegation_id').eq('case_id', caseId),
      ]);
      const completed = new Set((findings ?? []).map((f) => f.allegation_id));
      if (!(allegations ?? []).length || (allegations ?? []).some((a) => !completed.has(a.id))) return json({ error: 'Finding per dugaan belum lengkap.' }, 409);
      const { data: review, error } = await admin.from('case_authority_reviews')
        .insert({ case_id: caseId, reviewer_user_id: user.id, decision, review_notes: notes }).select('id').single();
      if (error) throw error;
      const nextStatus = decision === 'APPROVED' ? 'REMEDIATION' : 'INVESTIGATION';
      await admin.from('cases').update({ status: nextStatus, updated_at: new Date().toISOString() }).eq('id', caseId);
      await admin.from('audit_logs').insert({
        organization_id: orgId, case_id: caseId, actor_user_id: user.id,
        event_type: decision === 'APPROVED' ? 'FINDINGS_APPROVED' : 'FINDINGS_RETURNED_FOR_REVISION',
        object_type: 'case_authority_review', object_id: review.id, details: { next_status: nextStatus },
      });
      return json({ ok: true, status: nextStatus });
    }

    if (action === 'ADD_REMEDIATION_ACTION') {
      if (caseRow.status !== 'REMEDIATION') return json({ error: 'Action item hanya dapat ditambah pada tahap Tindak Lanjut.' }, 409);
      const actionText = String(body.actionText ?? '').trim();
      const ownerText = String(body.ownerText ?? '').trim().slice(0, 240) || null;
      const dueDate = String(body.dueDate ?? '').trim() || null;
      if (actionText.length < 5 || actionText.length > 5000) return json({ error: 'Tindak lanjut harus 5–5.000 karakter.' }, 400);
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return json({ error: 'Tanggal target tidak valid.' }, 400);
      const { data: item, error } = await admin.from('case_remediation_actions')
        .insert({ case_id: caseId, action_text: actionText, owner_text: ownerText, due_date: dueDate, created_by: user.id }).select('id').single();
      if (error) throw error;
      await admin.from('audit_logs').insert({ organization_id: orgId, case_id: caseId, actor_user_id: user.id, event_type: 'REMEDIATION_ACTION_ADDED', object_type: 'case_remediation_action', object_id: item.id, details: {} });
      return json({ ok: true });
    }

    if (action === 'COMPLETE_REMEDIATION_ACTION' || action === 'WAIVE_REMEDIATION_ACTION') {
      if (caseRow.status !== 'REMEDIATION') return json({ error: 'Tindak lanjut tidak sedang aktif.' }, 409);
      const remediationId = String(body.remediationId ?? '');
      const completionNote = String(body.completionNote ?? '').trim();
      if (completionNote.length < 5 || completionNote.length > 5000) return json({ error: 'Catatan penyelesaian/alasan waiver wajib 5–5.000 karakter.' }, 400);
      const status = action === 'COMPLETE_REMEDIATION_ACTION' ? 'COMPLETED' : 'WAIVED';
      const now = new Date().toISOString();
      const { data: item, error } = await admin.from('case_remediation_actions')
        .update({ status, completion_note: completionNote, completed_by: user.id, completed_at: now, updated_at: now })
        .eq('id', remediationId).eq('case_id', caseId).not('status', 'in', '(COMPLETED,WAIVED)').select('id').maybeSingle();
      if (error) throw error;
      if (!item) return json({ error: 'Action item tidak ditemukan atau sudah selesai.' }, 404);
      await admin.from('audit_logs').insert({
        organization_id: orgId, case_id: caseId, actor_user_id: user.id,
        event_type: status === 'COMPLETED' ? 'REMEDIATION_ACTION_COMPLETED' : 'REMEDIATION_ACTION_WAIVED',
        object_type: 'case_remediation_action', object_id: remediationId, details: {},
      });
      return json({ ok: true });
    }

    if (action === 'CLOSE_CASE') {
      if (caseRow.status !== 'REMEDIATION') return json({ error: 'Kasus hanya dapat ditutup pada tahap Tindak Lanjut.' }, 409);
      const internalSummary = String(body.internalSummary ?? '').trim();
      const reporterSummary = String(body.reporterSummary ?? '').trim();
      if (internalSummary.length < 5 || reporterSummary.length < 5) return json({ error: 'Ringkasan internal dan ringkasan untuk pelapor wajib diisi.' }, 400);
      const { data, error } = await admin.rpc('close_case_remediation', {
        p_case_id: caseId,
        p_actor_user_id: user.id,
        p_organization_id: orgId,
        p_internal_summary: internalSummary,
        p_reporter_summary: reporterSummary,
      });
      if (error) {
        const msg = error.message || '';
        if (msg.includes('PENDING_REMEDIATION')) return json({ error: 'Masih ada tindak lanjut yang belum diselesaikan atau di-waive.' }, 409);
        if (msg.includes('INCOMPLETE_FINDINGS')) return json({ error: 'Finding final belum lengkap.' }, 409);
        throw error;
      }
      return json(data);
    }

    if (caseRow.status !== 'COMMITTEE_FORMATION') return json({ error: 'Pembentukan tim hanya dapat diubah saat status Menunggu Pembentukan Tim.' }, 409);

    if (action === 'ADD_MEMBER') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const displayName = String(body.displayName ?? '').trim().slice(0, 200) || null;
      const memberCategory = String(body.memberCategory ?? '');
      const committeeRole = String(body.committeeRole ?? '');
      const rationale = String(body.rationale ?? '').trim();
      const conflictContext = String(body.conflictContext ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['DS','MANAGEMENT','STAFF','OTS','EXTERNAL'].includes(memberCategory) || !['CASE_LEAD','INVESTIGATOR','SUBJECT_MATTER_ADVISER'].includes(committeeRole) || rationale.length < 5 || conflictContext.length < 3) return json({ error: 'Data kandidat belum lengkap/valid.' }, 400);
      const { data: member, error } = await admin.from('case_team_members')
        .insert({ case_id: caseId, email, display_name: displayName, member_category: memberCategory, committee_role: committeeRole, rationale, conflict_context: conflictContext, nomination_status: 'PENDING_ACCOUNT', nominated_by: user.id }).select('id').single();
      if (error) {
        if ((error as any).code === '23505') return json({ error: 'Email ini sudah menjadi kandidat aktif pada laporan ini.' }, 409);
        throw error;
      }
      await admin.from('audit_logs').insert({ organization_id: orgId, case_id: caseId, actor_user_id: user.id, event_type: 'TEAM_MEMBER_NOMINATED', object_type: 'case_team_member', object_id: member.id, details: { committee_role: committeeRole } });
      return json({ ok: true });
    }

    if (action === 'REVOKE_MEMBER') {
      const memberId = String(body.memberId ?? '');
      const now = new Date().toISOString();
      const { data: member } = await admin.from('case_team_members').select('linked_user_id').eq('id', memberId).eq('case_id', caseId).single();
      if (!member) return json({ error: 'Kandidat tidak ditemukan.' }, 404);
      await admin.from('case_team_members').update({ nomination_status: 'REVOKED', revoked_at: now, updated_at: now }).eq('id', memberId);
      if (member.linked_user_id) await admin.from('case_assignments').update({ access_status: 'REVOKED', revoked_at: now }).eq('case_id', caseId).eq('user_id', member.linked_user_id);
      return json({ ok: true });
    }

    if (action === 'ACTIVATE_TEAM') {
      const { data: team } = await admin.from('case_team_members').select('linked_user_id,committee_role').eq('case_id', caseId).eq('nomination_status', 'CLEARED');
      const investigators = (team ?? []).filter((m) => m.linked_user_id && ['CASE_LEAD','INVESTIGATOR'].includes(m.committee_role));
      const users = [...new Set(investigators.map((m) => m.linked_user_id))];
      if (users.length < 2) return json({ error: 'Tim Pemeriksa membutuhkan minimum 2 orang berbeda yang telah lolos deklarasi benturan kepentingan.' }, 409);
      if (!investigators.some((m) => m.committee_role === 'CASE_LEAD')) return json({ error: 'Tim Pemeriksa harus memiliki minimal satu Ketua Tim.' }, 409);
      await admin.from('case_assignments').update({ access_status: 'ACTIVE', revoked_at: null }).eq('case_id', caseId).in('user_id', users);
      await admin.from('cases').update({ status: 'INVESTIGATION', updated_at: new Date().toISOString() }).eq('id', caseId);
      return json({ ok: true, investigatorCount: users.length });
    }

    return json({ error: 'Aksi tidak dikenali.' }, 400);
  } catch (error) {
    console.error('secretariat-team-action', error);
    const code = error instanceof Error ? error.message : '';
    if (code === 'UNAUTHENTICATED') return json({ error: 'Silakan masuk terlebih dahulu.' }, 401);
    if (code === 'FORBIDDEN') return json({ error: 'Akun ini tidak memiliki kewenangan Sekretariat DS.' }, 403);
    if (code === 'CASE_NOT_FOUND') return json({ error: 'Laporan tidak ditemukan.' }, 404);
    return json({ error: 'Aksi Sekretariat belum dapat diproses.' }, 400);
  }
});
