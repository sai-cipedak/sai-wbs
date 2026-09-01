import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';

const cors={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
};
const admin=createClient(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',{auth:{persistSession:false,autoRefreshToken:false}});
const json=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
const RETIRED_MUTATIONS=new Set(['ADD_MEMBER','REVOKE_MEMBER','ACTIVATE_TEAM','REVIEW_FINDINGS','ADD_REMEDIATION_ACTION','COMPLETE_REMEDIATION_ACTION','WAIVE_REMEDIATION_ACTION']);

async function currentUser(req:Request){
  const token=(req.headers.get('Authorization')??'').replace(/^Bearer\s+/i,'');
  if(!token)throw new Error('UNAUTHENTICATED');
  const{data,error}=await admin.auth.getUser(token);
  if(error||!data.user)throw new Error('UNAUTHENTICATED');
  return data.user;
}
async function secretariatOrg(uid:string){
  const now=new Date().toISOString();
  const{data,error}=await admin.from('user_system_roles').select('organization_id,active_from,active_until').eq('user_id',uid).eq('role_code','SECRETARIAT').lte('active_from',now);
  if(error)throw error;
  const role=(data??[]).find((x)=>!x.active_until||x.active_until>now);
  if(!role)throw new Error('FORBIDDEN');
  return String(role.organization_id);
}
async function hasActiveRole(uid:string,orgId:string,roleCode:string){
  const now=new Date().toISOString();
  const{data,error}=await admin.from('user_system_roles').select('active_until').eq('user_id',uid).eq('organization_id',orgId).eq('role_code',roleCode).lte('active_from',now);
  if(error)throw error;
  return(data??[]).some((x)=>!x.active_until||x.active_until>now);
}
async function getCase(id:string,orgId:string){
  const{data,error}=await admin.from('cases').select('id,public_case_id,reporting_mode,status,classification,authority_code,submitted_at,updated_at,closed_at,is_test_data,test_label').eq('id',id).eq('organization_id',orgId).eq('authority_code','SECRETARIAT').maybeSingle();
  if(error)throw error;
  if(!data)throw new Error('CASE_NOT_FOUND');
  return data;
}
function followupState(row:any){
  if(row.status==='COMPLETED'||row.status==='CANCELLED')return row.status;
  const due=new Date(row.due_at).getTime(),now=Date.now();
  if(due<now)return'OVERDUE';
  if(due<=now+3*86400000)return'DUE_SOON';
  return'UPCOMING';
}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'Metode tidak diizinkan.'},405);
  try{
    const u=await currentUser(req);
    const orgId=await secretariatOrg(u.id);
    const body=await req.json().catch(()=>({}));
    const action=String(body.action??'LIST').toUpperCase();
    const requestedUat=body.uat===true;
    const allowUat=requestedUat&&await hasActiveRole(u.id,orgId,'SYSTEM_ADMIN');
    if(requestedUat&&!allowUat)return json({error:'Mode UAT hanya tersedia untuk SYSTEM_ADMIN aktif.'},403);

    if(RETIRED_MUTATIONS.has(action))return json({error:'Workflow ini sudah diperbarui. Muat ulang halaman untuk menggunakan jalur transaksi terbaru.'},409);

    if(action==='LIST'){
      let q=admin.from('cases').select('id,public_case_id,reporting_mode,status,classification,authority_code,submitted_at,is_test_data,test_label').eq('organization_id',orgId).eq('authority_code','SECRETARIAT').neq('status','CLOSED').neq('status','OUT_OF_SCOPE');
      if(!allowUat)q=q.eq('is_test_data',false);
      const{data,error}=await q.order('submitted_at',{ascending:false});
      if(error)throw error;
      const ids=(data??[]).map((x)=>x.id);
      const{data:reports,error:reportError}=ids.length?await admin.from('case_reports').select('case_id,title').in('case_id',ids):{data:[],error:null} as any;
      if(reportError)throw reportError;
      const titles=new Map((reports??[]).map((r:any)=>[r.case_id,r.title]));
      return json({cases:(data??[]).map((c)=>({...c,title:titles.get(c.id)??c.public_case_id})),uat:allowUat});
    }

    if(action==='LIST_FOLLOWUPS'){
      let cq=admin.from('cases').select('id,public_case_id,classification,reporting_mode,closed_at,is_test_data,test_label').eq('organization_id',orgId).eq('authority_code','SECRETARIAT').eq('status','CLOSED');
      if(!allowUat)cq=cq.eq('is_test_data',false);
      const{data:closed,error:closedError}=await cq.order('closed_at',{ascending:false});
      if(closedError)throw closedError;
      const ids=(closed??[]).map((x)=>x.id);
      if(!ids.length)return json({followups:[],counts:{upcoming:0,dueSoon:0,overdue:0,openEscalations:0}});
      const[{data:fu,error:followupError},{data:reports,error:reportError}]=await Promise.all([
        admin.from('case_followups').select('id,case_id,closure_id,day_offset,due_at,status,check_method,outcome,risk_level,notes,completed_at,escalation_required,escalation_note,escalation_status,escalation_resolution_note,escalation_resolved_at,escalation_resolution_mode,linked_case_id').in('case_id',ids).order('due_at'),
        admin.from('case_reports').select('case_id,title').in('case_id',ids),
      ]);
      if(followupError||reportError)throw followupError??reportError;
      const linkedIds=[...new Set((fu??[]).map((x:any)=>x.linked_case_id).filter(Boolean))];
      const{data:linkedCases,error:linkedError}=linkedIds.length?await admin.from('cases').select('id,public_case_id,status,authority_code').in('id',linkedIds):{data:[],error:null} as any;
      if(linkedError)throw linkedError;
      const caseMap=new Map((closed??[]).map((c:any)=>[c.id,c]));
      const titleMap=new Map((reports??[]).map((r:any)=>[r.case_id,r.title]));
      const linkedMap=new Map((linkedCases??[]).map((c:any)=>[c.id,c]));
      const rows=(fu??[]).map((f:any)=>{const c=caseMap.get(f.case_id);return{...f,effective_status:followupState(f),public_case_id:c.public_case_id,classification:c.classification,reporting_mode:c.reporting_mode,closed_at:c.closed_at,title:titleMap.get(f.case_id)??c.public_case_id,linked_case:f.linked_case_id?(linkedMap.get(f.linked_case_id)??null):null};});
      return json({followups:rows,counts:{upcoming:rows.filter((x:any)=>x.effective_status==='UPCOMING').length,dueSoon:rows.filter((x:any)=>x.effective_status==='DUE_SOON').length,overdue:rows.filter((x:any)=>x.effective_status==='OVERDUE').length,openEscalations:rows.filter((x:any)=>x.escalation_status==='OPEN').length}});
    }

    const caseId=String(body.caseId??'');
    if(!caseId)return json({error:'Case ID wajib.'},400);
    const c=await getCase(caseId,orgId);
    if(c.is_test_data&&!allowUat)return json({error:'Laporan tidak ditemukan.'},404);

    if(action==='DETAIL'){
      const results=await Promise.all([
        admin.from('case_reports').select('case_id,title,narrative,incident_date,incident_time_text,location_text,child_safety_risk,ongoing_risk,people_involved_text,submitted_at').eq('case_id',caseId).single(),
        admin.from('case_messages').select('id,sender_type,body,visible_to_reporter,created_at').eq('case_id',caseId).order('created_at'),
        admin.from('case_team_members').select('id,email,display_name,member_category,committee_role,nomination_status,linked_user_id,nominated_at,declaration_at').eq('case_id',caseId).neq('nomination_status','REVOKED').order('nominated_at'),
        admin.from('case_assignments').select('user_id,assignment_role,access_status').eq('case_id',caseId),
        admin.from('case_allegations').select('id,sequence_no,statement,status').eq('case_id',caseId).eq('status','ACTIVE').order('sequence_no'),
        admin.from('case_findings').select('id,allegation_id,finding_status,analysis_text,recommendation_text,updated_at').eq('case_id',caseId),
        admin.from('case_authority_reviews').select('id,decision,review_notes,created_at').eq('case_id',caseId).order('created_at',{ascending:false}),
        admin.from('case_remediation_actions').select('id,action_text,owner_text,due_date,status,completion_note,created_at,updated_at,completed_at').eq('case_id',caseId).order('created_at'),
      ]);
      const firstError=results.find((x)=>x.error)?.error;
      if(firstError)throw firstError;
      const[report,messages,team,assignments,allegations,findings,reviews,remediation]=results.map((x)=>x.data);
      const assignmentMap=new Map((assignments??[]).map((a:any)=>[`${a.user_id}|${a.assignment_role}`,a.access_status]));
      return json({case:c,report,messages:messages??[],team:(team??[]).map((m:any)=>({...m,assignment_status:m.linked_user_id?(assignmentMap.get(`${m.linked_user_id}|${m.committee_role}`)??null):null})),allegations:allegations??[],findings:findings??[],reviews:reviews??[],remediation:remediation??[]});
    }

    if(action==='COMPLETE_FOLLOWUP'){
      if(c.status!=='CLOSED')return json({error:'Follow-up hanya berlaku untuk kasus yang sudah ditutup.'},409);
      const followupId=String(body.followupId??''),checkMethod=String(body.checkMethod??''),outcome=String(body.outcome??''),riskLevel=String(body.riskLevel??''),notes=String(body.notes??'').trim(),escalationNote=String(body.escalationNote??'').trim();
      if(!followupId)return json({error:'Jadwal follow-up wajib dipilih.'},400);
      const{data,error}=await admin.rpc('complete_case_followup',{p_followup_id:followupId,p_actor_user_id:u.id,p_organization_id:orgId,p_check_method:checkMethod,p_outcome:outcome,p_risk_level:riskLevel,p_notes:notes,p_escalation_note:escalationNote||null});
      if(error){const m=error.message??'';if(m.includes('FOLLOWUP_ALREADY_COMPLETED'))return json({error:'Follow-up ini sudah diproses.'},409);if(m.includes('ESCALATION_NOTE_REQUIRED'))return json({error:'Temuan ini memerlukan catatan eskalasi.'},400);if(m.includes('NOTES_REQUIRED'))return json({error:'Catatan follow-up wajib 5–5.000 karakter.'},400);if(m.includes('CASE_NOT_CLOSED'))return json({error:'Kasus tidak lagi berada dalam status tertutup.'},409);throw error;}
      return json(data);
    }

    if(action==='RESOLVE_FOLLOWUP_ESCALATION'){
      if(c.status!=='CLOSED')return json({error:'Eskalasi follow-up hanya berlaku untuk kasus yang sudah ditutup.'},409);
      const followupId=String(body.followupId??''),resolutionNote=String(body.resolutionNote??'').trim();
      const{data,error}=await admin.rpc('resolve_case_followup_escalation',{p_followup_id:followupId,p_actor_user_id:u.id,p_organization_id:orgId,p_resolution_note:resolutionNote});
      if(error){const m=error.message??'';if(m.includes('LINKED_CASE_REQUIRED'))return json({error:'Eskalasi retaliation tidak dapat ditutup sebelum linked case dibuat.'},409);if(m.includes('ESCALATION_NOT_OPEN'))return json({error:'Eskalasi terbuka tidak ditemukan.'},404);if(m.includes('RESOLUTION_REQUIRED'))return json({error:'Catatan penyelesaian eskalasi wajib 5–5.000 karakter.'},400);throw error;}
      return json(data);
    }

    if(action==='CLOSE_CASE'){
      if(c.status!=='REMEDIATION')return json({error:'Kasus hanya dapat ditutup pada tahap Tindak Lanjut.'},409);
      const internalSummary=String(body.internalSummary??'').trim(),reporterSummary=String(body.reporterSummary??'').trim();
      if(internalSummary.length<5||reporterSummary.length<5)return json({error:'Ringkasan internal dan ringkasan untuk pelapor wajib diisi.'},400);
      const{data,error}=await admin.rpc('close_case_remediation',{p_case_id:caseId,p_actor_user_id:u.id,p_organization_id:orgId,p_internal_summary:internalSummary,p_reporter_summary:reporterSummary});
      if(error){const m=error.message??'';if(m.includes('PENDING_REMEDIATION'))return json({error:'Masih ada tindak lanjut yang belum diselesaikan atau di-waive.'},409);if(m.includes('INCOMPLETE_FINDINGS'))return json({error:'Finding final belum lengkap.'},409);throw error;}
      return json(data);
    }

    return json({error:'Aksi tidak dikenali.'},400);
  }catch(e){
    console.error('secretariat-team-action',e);
    const code=e instanceof Error?e.message:'';
    if(code==='UNAUTHENTICATED')return json({error:'Silakan masuk terlebih dahulu.'},401);
    if(code==='FORBIDDEN')return json({error:'Akun ini tidak memiliki kewenangan Sekretariat DS.'},403);
    if(code==='CASE_NOT_FOUND')return json({error:'Laporan tidak ditemukan.'},404);
    return json({error:'Aksi Sekretariat belum dapat diproses.'},400);
  }
});
