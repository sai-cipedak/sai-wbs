import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false, autoRefreshToken: false } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' } });

async function requireUser(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('UNAUTHENTICATED');
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user?.email) throw new Error('UNAUTHENTICATED');
  return data.user;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Metode tidak diizinkan.' }, 405);
  try {
    const user = await requireUser(req);
    const email = user.email!.trim().toLowerCase();
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? 'LIST');

    if (action === 'LIST') {
      const { data: members, error } = await admin.from('case_team_members')
        .select('id,case_id,email,display_name,member_category,committee_role,rationale,conflict_context,nomination_status,nominated_at,declaration_at')
        .eq('email', email).neq('nomination_status','REVOKED').order('nominated_at', { ascending: false });
      if (error) throw error;

      const caseIds = [...new Set((members ?? []).map((m) => m.case_id))];
      const { data: cases } = caseIds.length ? await admin.from('cases').select('id,public_case_id,classification,status,organization_id,authority_code').in('id', caseIds) : { data: [] } as any;
      const caseMap = new Map((cases ?? []).map((c: any) => [c.id, c]));

      const { data: assignments } = caseIds.length
        ? await admin.from('case_assignments').select('case_id,assignment_role,access_status').eq('user_id', user.id).in('case_id', caseIds)
        : { data: [] } as any;
      const assignmentMap = new Map((assignments ?? []).map((a: any) => [`${a.case_id}|${a.assignment_role}`, a.access_status]));

      for (const member of members ?? []) {
        if (!member.declaration_at && member.nomination_status === 'PENDING_ACCOUNT') {
          await admin.from('case_team_members').update({ linked_user_id: user.id, nomination_status: 'PENDING_DECLARATION', updated_at: new Date().toISOString() }).eq('id', member.id);
          member.nomination_status = 'PENDING_DECLARATION';
        }
      }

      const firstCase = (cases ?? [])[0];
      if (firstCase) {
        const { data: existingProfile } = await admin.from('profiles').select('user_id').eq('user_id', user.id).maybeSingle();
        if (!existingProfile) {
          await admin.from('profiles').insert({
            user_id: user.id,
            organization_id: firstCase.organization_id,
            display_name: String(user.user_metadata?.full_name ?? user.user_metadata?.name ?? email).slice(0, 200),
            email,
            member_type: 'INTERNAL',
            is_active: true,
          });
        }
      }

      return json({ nominations: (members ?? []).map((m) => {
        const c = caseMap.get(m.case_id) as any;
        return {
          id: m.id,
          nomorLaporan: c?.public_case_id ?? null,
          classification: c?.classification ?? null,
          caseStatus: c?.status ?? null,
          authorityCode: c?.authority_code ?? null,
          displayName: m.display_name,
          memberCategory: m.member_category,
          committeeRole: m.committee_role,
          rationale: m.rationale,
          conflictContext: m.conflict_context,
          nominationStatus: m.nomination_status,
          assignmentStatus: assignmentMap.get(`${m.case_id}|${m.committee_role}`) ?? null,
          nominatedAt: m.nominated_at,
          declarationAt: m.declaration_at,
        };
      }) });
    }

    if (action === 'DECLARE') {
      const memberId = String(body.memberId ?? '');
      const declaration = String(body.declaration ?? '');
      const notes = String(body.notes ?? '').trim().slice(0, 2000) || null;
      if (!['NO_CONFLICT','POSSIBLE_CONFLICT'].includes(declaration)) return json({ error: 'Pilih hasil deklarasi benturan kepentingan.' }, 400);

      const { data: member, error } = await admin.from('case_team_members')
        .select('id,case_id,email,committee_role,nomination_status,nominated_by')
        .eq('id', memberId).eq('email', email).neq('nomination_status','REVOKED').single();
      if (error || !member) return json({ error: 'Penunjukan Tim Pemeriksa tidak ditemukan untuk akun ini.' }, 404);
      if (['CLEARED','CONFLICT'].includes(member.nomination_status)) return json({ error: 'Deklarasi untuk penunjukan ini sudah disampaikan.' }, 409);

      const { data: caseRow, error: caseError } = await admin.from('cases').select('id,organization_id,public_case_id,status,authority_code').eq('id', member.case_id).single();
      if (caseError || !caseRow) return json({ error: 'Laporan tidak ditemukan.' }, 404);
      if (caseRow.status !== 'COMMITTEE_FORMATION') return json({ error: 'Pembentukan Tim Pemeriksa untuk laporan ini sudah tidak terbuka.' }, 409);

      const now = new Date().toISOString();
      await admin.from('case_conflict_declarations').upsert({ case_id: member.case_id, user_id: user.id, declaration, notes, declared_at: now }, { onConflict: 'case_id,user_id' });

      if (declaration === 'POSSIBLE_CONFLICT') {
        await admin.from('case_team_members').update({ linked_user_id: user.id, nomination_status: 'CONFLICT', declaration_at: now, updated_at: now }).eq('id', memberId);
        await admin.from('case_assignments').update({ access_status: 'REVOKED', revoked_at: now }).eq('case_id', member.case_id).eq('user_id', user.id);
        await admin.from('audit_logs').insert({ organization_id: caseRow.organization_id, case_id: member.case_id, actor_user_id: user.id, event_type: 'TEAM_MEMBER_CONFLICT_DECLARED', object_type: 'case_team_member', object_id: memberId, details: { authority_code: caseRow.authority_code } });
        return json({ ok: true, nomorLaporan: caseRow.public_case_id, nominationStatus: 'CONFLICT', accessGranted: false });
      }

      await admin.from('case_team_members').update({ linked_user_id: user.id, nomination_status: 'CLEARED', declaration_at: now, updated_at: now }).eq('id', memberId);
      await admin.from('case_assignments').upsert({
        case_id: member.case_id,
        user_id: user.id,
        assignment_role: member.committee_role,
        access_status: 'PENDING',
        assigned_by: member.nominated_by,
        assigned_at: now,
        revoked_at: null,
      }, { onConflict: 'case_id,user_id,assignment_role' });
      await admin.from('audit_logs').insert({ organization_id: caseRow.organization_id, case_id: member.case_id, actor_user_id: user.id, event_type: 'TEAM_MEMBER_CONFLICT_CLEARED', object_type: 'case_team_member', object_id: memberId, details: { committee_role: member.committee_role, authority_code: caseRow.authority_code } });
      return json({ ok: true, nomorLaporan: caseRow.public_case_id, nominationStatus: 'CLEARED', accessGranted: false, note: 'Akses case baru aktif setelah otoritas kasus mengaktifkan Tim Pemeriksa.' });
    }

    return json({ error: 'Aksi tidak dikenali.' }, 400);
  } catch (error) {
    console.error('team-member-declaration', error);
    if (error instanceof Error && error.message === 'UNAUTHENTICATED') return json({ error: 'Silakan masuk dengan akun Google yang menerima penunjukan.' }, 401);
    return json({ error: 'Deklarasi belum dapat diproses.' }, 400);
  }
});