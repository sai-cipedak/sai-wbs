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
      .select('id, organization_id, public_case_id, status, authority_code')
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

    switch (action) {
      case 'START_REVIEW':
        if (!['SUBMITTED', 'MORE_INFO_REQUIRED'].includes(caseRow.status)) {
          return jsonResponse({ error: 'Status laporan belum dapat masuk penelaahan.' }, 409);
        }
        break;
      case 'REQUEST_INFO':
        if (!reporterMessage) return jsonResponse({ error: 'Pertanyaan untuk pelapor wajib diisi minimal 10 karakter.' }, 400);
        break;
      case 'ROUTE_INTEGRITY':
      case 'ROUTE_SAFEGUARDING':
      case 'ROUTE_GRIEVANCE':
        if (!internalReason) return jsonResponse({ error: 'Catatan alasan klasifikasi wajib diisi minimal 10 karakter.' }, 400);
        break;
      case 'ROUTE_DEKOM':
        if (!internalReason) return jsonResponse({ error: 'Alasan pengambilalihan Dekom wajib diisi minimal 10 karakter.' }, 400);
        break;
      case 'CLOSE_OUT_OF_SCOPE':
        if (!internalReason || !reporterExplanation) {
          return jsonResponse({ error: 'Alasan internal dan penjelasan untuk pelapor wajib diisi.' }, 400);
        }
        break;
    }

    const { data: result, error: actionError } = await admin.rpc('apply_triage_action_atomic', {
      p_case_id: caseRow.id,
      p_actor_user_id: user.id,
      p_expected_status: caseRow.status,
      p_action: action,
      p_internal_reason: internalReason,
      p_reporter_explanation: reporterExplanation,
      p_reporter_message: reporterMessage,
    });

    if (actionError) {
      const message = actionError.message ?? '';
      if (message.includes('CASE_NOT_FOUND')) return jsonResponse({ error: 'Laporan tidak ditemukan.' }, 404);
      if (message.includes('TRIAGE_AUTHORITY_CHANGED')) {
        return jsonResponse({ error: 'Laporan ini sudah tidak berada dalam kewenangan Penelaah Awal.' }, 409);
      }
      if (message.includes('CASE_CHANGED') || message.includes('INVALID_START_REVIEW_STATUS')) {
        return jsonResponse({ error: 'Laporan berubah saat diproses. Muat ulang halaman.' }, 409);
      }
      if (message.includes('INVALID_INTERNAL_REASON') || message.includes('INVALID_REPORTER_EXPLANATION') || message.includes('INVALID_REPORTER_MESSAGE') || message.includes('INVALID_ACTION') || message.includes('INVALID_ARGUMENT')) {
        return jsonResponse({ error: 'Data aksi penelaahan tidak valid.' }, 400);
      }
      throw actionError;
    }

    return jsonResponse({
      ok: true,
      nomorLaporan: result?.nomorLaporan ?? caseRow.public_case_id,
      action,
    });
  } catch (error) {
    console.error('triage-case-action', error);
    return jsonResponse({ error: 'Aksi penelaahan belum dapat disimpan. Silakan coba kembali.' }, 500);
  }
});
