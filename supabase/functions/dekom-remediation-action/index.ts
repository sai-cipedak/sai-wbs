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

async function currentUser(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('UNAUTHENTICATED');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new Error('UNAUTHENTICATED');
  return data.user;
}

async function dekomOrg(uid: string) {
  const now = new Date().toISOString();
  const { data, error } = await admin.from('user_system_roles')
    .select('organization_id,active_from,active_until')
    .eq('user_id', uid).eq('role_code', 'DEKOM').lte('active_from', now);
  if (error) throw error;
  const row = (data ?? []).find((r: any) => !r.active_until || r.active_until > now);
  if (!row) throw new Error('FORBIDDEN');
  return String(row.organization_id);
}

async function dekomCase(caseId: string, orgId: string) {
  const { data, error } = await admin.from('cases')
    .select('id,public_case_id,status,authority_code,organization_id')
    .eq('id', caseId).eq('organization_id', orgId).eq('authority_code', 'DEKOM').single();
  if (error || !data) throw new Error('CASE_NOT_FOUND');
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Metode tidak diizinkan.' }, 405);

  try {
    const user = await currentUser(req);
    const orgId = await dekomOrg(user.id);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? 'DETAIL');
    const caseId = String(body.caseId ?? '');
    if (!caseId) return json({ error: 'Case ID wajib.' }, 400);

    const c = await dekomCase(caseId, orgId);
    if (c.status !== 'REMEDIATION' && action !== 'DETAIL') {
      return json({ error: 'Aksi tindak lanjut hanya tersedia pada tahap Tindak Lanjut.' }, 409);
    }

    if (action === 'DETAIL') {
      const { data, error } = await admin.from('case_remediation_actions')
        .select('id,action_text,owner_text,due_date,status,completion_note,created_at,updated_at,completed_at')
        .eq('case_id', caseId).order('created_at', { ascending: true });
      if (error) throw error;
      return json({ caseStatus: c.status, remediation: data ?? [] });
    }

    if (action === 'ADD') {
      const actionText = String(body.actionText ?? '').trim();
      const ownerText = String(body.ownerText ?? '').trim().slice(0, 500) || null;
      const dueDate = String(body.dueDate ?? '').trim() || null;
      if (actionText.length < 5 || actionText.length > 5000) {
        return json({ error: 'Tindak lanjut wajib 5–5.000 karakter.' }, 400);
      }
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return json({ error: 'Format target tanggal tidak valid.' }, 400);
      }
      const { data: row, error } = await admin.from('case_remediation_actions').insert({
        case_id: caseId,
        action_text: actionText,
        owner_text: ownerText,
        due_date: dueDate,
        status: 'PENDING',
        created_by: user.id,
      }).select('id').single();
      if (error) throw error;
      await admin.from('audit_logs').insert({
        organization_id: orgId,
        case_id: caseId,
        actor_user_id: user.id,
        event_type: 'REMEDIATION_ACTION_ADDED',
        object_type: 'case_remediation_action',
        object_id: row.id,
        details: { authority_code: 'DEKOM' },
      });
      return json({ ok: true, id: row.id });
    }

    if (action === 'COMPLETE') {
      const remediationId = String(body.remediationId ?? '');
      const completionNote = String(body.completionNote ?? '').trim();
      const waive = Boolean(body.waive);
      if (!remediationId) return json({ error: 'Action item tidak ditemukan.' }, 400);
      if (completionNote.length < 5 || completionNote.length > 5000) {
        return json({ error: 'Catatan penyelesaian/waiver wajib 5–5.000 karakter.' }, 400);
      }
      const { data: existing } = await admin.from('case_remediation_actions')
        .select('id,status').eq('id', remediationId).eq('case_id', caseId).maybeSingle();
      if (!existing) return json({ error: 'Action item tidak ditemukan.' }, 404);
      if (['COMPLETED', 'WAIVED'].includes(existing.status)) {
        return json({ error: 'Action item ini sudah selesai.' }, 409);
      }
      const now = new Date().toISOString();
      const status = waive ? 'WAIVED' : 'COMPLETED';
      const { error } = await admin.from('case_remediation_actions').update({
        status,
        completion_note: completionNote,
        completed_by: user.id,
        completed_at: now,
        updated_at: now,
      }).eq('id', remediationId).eq('case_id', caseId);
      if (error) throw error;
      await admin.from('audit_logs').insert({
        organization_id: orgId,
        case_id: caseId,
        actor_user_id: user.id,
        event_type: waive ? 'REMEDIATION_ACTION_WAIVED' : 'REMEDIATION_ACTION_COMPLETED',
        object_type: 'case_remediation_action',
        object_id: remediationId,
        details: { authority_code: 'DEKOM' },
      });
      return json({ ok: true, status });
    }

    if (action === 'CLOSE') {
      const internalSummary = String(body.internalSummary ?? '').trim();
      const reporterSummary = String(body.reporterSummary ?? '').trim();
      if (internalSummary.length < 5 || reporterSummary.length < 5) {
        return json({ error: 'Ringkasan internal dan ringkasan untuk pelapor wajib diisi.' }, 400);
      }
      const { data, error } = await admin.rpc('close_case_remediation', {
        p_case_id: caseId,
        p_actor_user_id: user.id,
        p_organization_id: orgId,
        p_internal_summary: internalSummary,
        p_reporter_summary: reporterSummary,
      });
      if (error) {
        const msg = String(error.message ?? '');
        if (msg.includes('PENDING_REMEDIATION')) return json({ error: 'Masih ada tindak lanjut yang belum selesai atau di-waive.' }, 409);
        if (msg.includes('NOT_IN_REMEDIATION')) return json({ error: 'Case sudah tidak berada pada tahap Tindak Lanjut.' }, 409);
        console.error(error);
        return json({ error: 'Kasus belum dapat ditutup.' }, 409);
      }
      return json(data);
    }

    return json({ error: 'Aksi tidak dikenali.' }, 400);
  } catch (e) {
    console.error('dekom-remediation-action', e);
    const m = e instanceof Error ? e.message : '';
    if (m === 'UNAUTHENTICATED') return json({ error: 'Silakan masuk terlebih dahulu.' }, 401);
    if (m === 'FORBIDDEN') return json({ error: 'Akun ini tidak memiliki kewenangan Dekom.' }, 403);
    if (m === 'CASE_NOT_FOUND') return json({ error: 'Kasus Dekom tidak ditemukan.' }, 404);
    return json({ error: 'Tindak lanjut Dekom belum dapat diproses.' }, 400);
  }
});
