import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';
import { corsHeaders } from '../_shared/cors.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
});

const ACTIONS = new Set([
  'START_REVIEW', 'REQUEST_INFO', 'ROUTE_INTEGRITY', 'ROUTE_SAFEGUARDING',
  'ROUTE_GRIEVANCE', 'ROUTE_DEKOM', 'CLOSE_OUT_OF_SCOPE',
]);

function cleanText(value: unknown, min = 0, max = 4000) {
  const text = String(value ?? '').trim();
  if (text.length < min || text.length > max) return null;
  return text;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Metode tidak diizinkan.' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return jsonResponse({ error: 'Silakan masuk terlebih dahulu.' }, 401);

  try {
    const { data: userResult, error: userError } = await admin.auth.getUser(token);
    const user = userResult.user;
    if (userError || !user) return jsonResponse({ error: 'Sesi tidak valid.' }, 401);

    const payload = await req.json() as Record<string, unknown>;
    const action = String(payload.action ?? '').toUpperCase();
    const caseId = String(payload.caseId ?? '');
    if (!ACTIONS.has(action) || !caseId) return jsonResponse({ error: 'Aksi atau laporan tidak valid.' }, 400);

    const { data: caseRow, error: caseError } = await admin
      .from('cases')
      .select('id, organization_id, public_case_id, reporting_mode, status, classification, priority, authority_code, closed_at')
      .eq('id', caseId)
      .single();
    if (caseError || !caseRow) return jsonResponse({ error: 'Laporan tidak ditemukan.' }, 404);

    const now = new Date();
    const { data: roleRows, error: roleError } = await admin
      .from('user_system_roles')
      .select('active_from, active_until')
      .eq('user_id', user.id)
      .eq('organization_id', caseRow.organization_id)
      .eq('role_code', 'TRIAGE');
    if (roleError) throw roleError;
    const hasRole = (roleRows ?? []).some((r) => {
      const from = new Date(r.active_from).getTime();
      const until = r.active_until ? new Date(r.active_until).getTime() : Number.POSITIVE_INFINITY;
      return from <= now.getTime() && now.getTime() < until;
    });
    if (!hasRole) return jsonResponse({ error: 'Anda tidak memiliki kewenangan Penelaah Awal.' }, 403);

    if (caseRow.authority_code !== 'TRIAGE' || ['CLOSED', 'OUT_OF_SCOPE'].includes(caseRow.status)) {
      return jsonResponse({ error: 'Laporan ini sudah tidak berada dalam kewenangan Penelaah Awal.' }, 409);
    }

    const internalReason = cleanText(payload.internalReason, 10, 4000);
    const reporterExplanation = cleanText(payload.reporterExplanation, 10, 4000);
    const reporterMessage = cleanText(payload.reporterMessage, 10, 4000);

    const next: Record<string, unknown> = {};
    let decisionClassification: string | null = null;
    let targetAuthority = 'TRIAGE';
    let auditEvent = '';
    let messageBody: string | null = null;

    switch (action) {
      case 'START_REVIEW':
        if (!['SUBMITTED', 'MORE_INFO_REQUIRED'].includes(caseRow.status)) return jsonResponse({ error: 'Status laporan belum dapat masuk penelaahan.' }, 409);
        next.status = 'UNDER_REVIEW';
        auditEvent = 'TRIAGE_REVIEW_STARTED';
        break;
      case 'REQUEST_INFO':
        if (!reporterMessage) return jsonResponse({ error: 'Pertanyaan untuk pelapor wajib diisi minimal 10 karakter.' }, 400);
        next.status = 'MORE_INFO_REQUIRED';
        messageBody = reporterMessage;
        auditEvent = 'TRIAGE_INFO_REQUESTED';
        break;
      case 'ROUTE_INTEGRITY':
        if (!internalReason) return jsonResponse({ error: 'Catatan alasan klasifikasi wajib diisi minimal 10 karakter.' }, 400);
        next.status = 'COMMITTEE_FORMATION'; next.classification = 'INTEGRITY'; next.authority_code = 'SECRETARIAT';
        decisionClassification = 'INTEGRITY'; targetAuthority = 'SECRETARIAT'; auditEvent = 'CASE_ROUTED_INTEGRITY';
        break;
      case 'ROUTE_SAFEGUARDING':
        if (!internalReason) return jsonResponse({ error: 'Catatan alasan klasifikasi wajib diisi minimal 10 karakter.' }, 400);
        next.status = 'REFERRED_SAFEGUARDING'; next.classification = 'SAFEGUARDING'; next.authority_code = 'HSE';
        decisionClassification = 'SAFEGUARDING'; targetAuthority = 'HSE'; auditEvent = 'CASE_ROUTED_SAFEGUARDING';
        break;
      case 'ROUTE_GRIEVANCE':
        if (!internalReason) return jsonResponse({ error: 'Catatan alasan klasifikasi wajib diisi minimal 10 karakter.' }, 400);
        next.status = 'REFERRED_GRIEVANCE'; next.classification = 'GRIEVANCE'; next.authority_code = 'GRIEVANCE';
        decisionClassification = 'GRIEVANCE'; targetAuthority = 'GRIEVANCE'; auditEvent = 'CASE_ROUTED_GRIEVANCE';
        break;
      case 'ROUTE_DEKOM':
        if (!internalReason) return jsonResponse({ error: 'Alasan pengambilalihan Dekom wajib diisi minimal 10 karakter.' }, 400);
        next.status = 'COMMITTEE_FORMATION'; next.authority_code = 'DEKOM';
        targetAuthority = 'DEKOM'; auditEvent = 'CASE_ROUTED_DEKOM';
        break;
      case 'CLOSE_OUT_OF_SCOPE':
        if (!internalReason || !reporterExplanation) return jsonResponse({ error: 'Alasan internal dan penjelasan untuk pelapor wajib diisi.' }, 400);
        next.status = 'OUT_OF_SCOPE'; next.classification = 'OUT_OF_SCOPE'; next.closed_at = new Date().toISOString();
        decisionClassification = 'OUT_OF_SCOPE'; auditEvent = 'CASE_CLOSED_OUT_OF_SCOPE';
        messageBody = reporterExplanation;
        break;
    }

    const previous = {
      status: caseRow.status,
      classification: caseRow.classification,
      priority: caseRow.priority,
      authority_code: caseRow.authority_code,
      closed_at: caseRow.closed_at,
    };

    const inserted: { messageId?: string; decisionId?: string } = {};
    try {
      const { data: updated, error: updateError } = await admin
        .from('cases')
        .update({ ...next, updated_at: new Date().toISOString() })
        .eq('id', caseRow.id)
        .eq('authority_code', 'TRIAGE')
        .eq('status', caseRow.status)
        .select('id')
        .maybeSingle();
      if (updateError) throw updateError;
      if (!updated) return jsonResponse({ error: 'Laporan berubah saat diproses. Muat ulang halaman.' }, 409);

      if (messageBody) {
        const { data: msg, error: msgError } = await admin.from('case_messages').insert({
          case_id: caseRow.id,
          sender_type: 'INTERNAL',
          sender_user_id: user.id,
          body: messageBody,
          visible_to_reporter: true,
        }).select('id').single();
        if (msgError || !msg) throw msgError ?? new Error('Gagal menyimpan pesan.');
        inserted.messageId = msg.id;
      }

      const { data: decision, error: decisionError } = await admin.from('case_triage_decisions').insert({
        case_id: caseRow.id,
        reviewer_user_id: user.id,
        action,
        classification: decisionClassification,
        target_authority: targetAuthority,
        internal_reason: internalReason,
        reporter_explanation: reporterExplanation ?? (action === 'REQUEST_INFO' ? reporterMessage : null),
      }).select('id').single();
      if (decisionError || !decision) throw decisionError ?? new Error('Gagal menyimpan keputusan penelaahan.');
      inserted.decisionId = decision.id;

      const { error: auditError } = await admin.from('audit_logs').insert({
        organization_id: caseRow.organization_id,
        case_id: caseRow.id,
        actor_user_id: user.id,
        event_type: auditEvent,
        object_type: 'case',
        object_id: caseRow.id,
        details: { action, target_authority: targetAuthority, classification: decisionClassification },
      });
      if (auditError) throw auditError;
    } catch (writeError) {
      if (inserted.messageId) await admin.from('case_messages').delete().eq('id', inserted.messageId);
      if (inserted.decisionId) await admin.from('case_triage_decisions').delete().eq('id', inserted.decisionId);
      await admin.from('cases').update({ ...previous, updated_at: new Date().toISOString() }).eq('id', caseRow.id);
      throw writeError;
    }

    return jsonResponse({ ok: true, nomorLaporan: caseRow.public_case_id, action });
  } catch (error) {
    console.error('triage-case-action', error);
    return jsonResponse({ error: 'Aksi penelaahan belum dapat disimpan. Silakan coba kembali.' }, 500);
  }
});
