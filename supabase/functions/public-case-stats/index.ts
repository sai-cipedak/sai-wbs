import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';
import { corsHeaders } from '../_shared/cors.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const GROUPS: Record<string, string[]> = {
  received: ['SUBMITTED'],
  review: ['UNDER_REVIEW', 'MORE_INFO_REQUIRED', 'REFERRED_GRIEVANCE', 'REFERRED_SAFEGUARDING', 'COMMITTEE_FORMATION'],
  handling: ['INVESTIGATION', 'AUTHORITY_REVIEW', 'REMEDIATION'],
  closed: ['CLOSED', 'OUT_OF_SCOPE'],
};

async function countStatuses(statuses?: string[]) {
  let query = admin.from('cases').select('id', { count: 'exact', head: true }).eq('is_test_data', false);
  if (statuses) query = query.in('status', statuses);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (!['GET', 'POST'].includes(request.method)) {
    return new Response(JSON.stringify({ error: 'Metode tidak diizinkan.' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  try {
    const [total, received, review, handling, closed] = await Promise.all([
      countStatuses(),
      countStatuses(GROUPS.received),
      countStatuses(GROUPS.review),
      countStatuses(GROUPS.handling),
      countStatuses(GROUPS.closed),
    ]);
    return new Response(JSON.stringify({ total, received, review, handling, closed, updatedAt: new Date().toISOString() }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    });
  } catch (error) {
    console.error('public-case-stats', error);
    return new Response(JSON.stringify({ error: 'Statistik belum dapat dimuat.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

