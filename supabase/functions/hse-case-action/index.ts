import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';

const cors={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
};
const admin=createClient(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',{auth:{persistSession:false,autoRefreshToken:false}});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});

async function currentUser(req:Request){
  const token=(req.headers.get('Authorization')??'').replace(/^Bearer\s+/i,'');
  if(!token)throw new Error('UNAUTHENTICATED');
  const{data,error}=await admin.auth.getUser(token);
  if(error||!data.user)throw new Error('UNAUTHENTICATED');
  return data.user;
}
async function hseOrg(uid:string){
  const now=new Date().toISOString();
  const{data:roles,error}=await admin.from('user_system_roles').select('organization_id,active_from,active_until').eq('user_id',uid).eq('role_code','HSE').lte('active_from',now);
  if(error)throw error;
  for(const r of roles??[]){
    if(r.active_until&&r.active_until<=now)continue;
    const{data:p}=await admin.from('profiles').select('is_active').eq('user_id',uid).eq('organization_id',r.organization_id).maybeSingle();
    if(p?.is_active)return String(r.organization_id);
  }
  throw new Error('FORBIDDEN');
}
async function getCase(caseId:string,orgId:string){
  const{data,error}=await admin.from('cases').select('id,organization_id,public_case_id,reporting_mode,status,classification,priority,authority_code,submitted_at,updated_at,is_test_data').eq('id',caseId).eq('organization_id',orgId).eq('authority_code','HSE').single();
  if(error||!data)throw new Error('CASE_NOT_FOUND');
  return data;
}
function text(v:unknown,min=0,max=5000){const s=String(v??'').trim();return s.length>=min&&s.length<=max?s:null;}
function jakartaDate(value:string|Date){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'Metode tidak diizinkan.'},405);
  try{
    const user=await currentUser(req);
    const orgId=await hseOrg(user.id);
    const body=await req.json().catch(()=>({}));
    const action=String(body.action??'LIST');

    if(action==='LIST'){
      const{data:cases,error}=await admin.from('cases')
        .select('id,public_case_id,reporting_mode,status,classification,priority,submitted_at,updated_at')
        .eq('organization_id',orgId).eq('authority_code','HSE').eq('is_test_data',false)
        .neq('status','CLOSED').neq('status','OUT_OF_SCOPE').order('submitted_at',{ascending:false});
      if(error)throw error;
      const ids=(cases??[]).map((c:any)=>c.id);
      const[{data:reports},{data:assessments},{data:protective}]=ids.length?await Promise.all([
        admin.from('case_reports').select('case_id,title,child_safety_risk,ongoing_risk').in('case_id',ids),
        admin.from('case_safeguarding_assessments').select('case_id,immediate_danger,assessed_at').in('case_id',ids).order('assessed_at',{ascending:false}),
        admin.from('case_protective_actions').select('case_id,id,initiated_at,status').in('case_id',ids).order('initiated_at',{ascending:false}),
      ]):[{data:[]},{data:[]},{data:[]}] as any;
      const rm=new Map((reports??[]).map((r:any)=>[r.case_id,r]));
      const am=new Map<string,any>();for(const a of assessments??[])if(!am.has(a.case_id))am.set(a.case_id,a);
      const pm=new Map<string,any[]>();for(const p of protective??[]){const arr=pm.get(p.case_id)??[];arr.push(p);pm.set(p.case_id,arr);}
      return json({cases:(cases??[]).map((c:any)=>{const r=rm.get(c.id)??{},a=am.get(c.id)??null,p=pm.get(c.id)??[];return{...c,title:r.title??c.public_case_id,child_safety_risk:!!r.child_safety_risk,ongoing_risk:!!r.ongoing_risk,assessment:a,protective_action_count:p.length,protective_same_day_required:a?.immediate_danger===true,protective_same_day_breached:a?.immediate_danger===true&&p.length===0&&jakartaDate(new Date())>jakartaDate(c.submitted_at)};})});
    }

    const caseId=String(body.caseId??'');
    if(!caseId)return json({error:'Case ID wajib.'},400);
    const c=await getCase(caseId,orgId);

    if(action==='DETAIL'){
      const q=await Promise.all([
        admin.from('case_reports').select('case_id,title,narrative,incident_date,incident_time_text,location_text,people_involved_text,child_safety_risk,ongoing_risk').eq('case_id',caseId).single(),
        admin.from('case_messages').select('id,sender_type,body,visible_to_reporter,created_at').eq('case_id',caseId).eq('visible_to_reporter',true).order('created_at'),
        admin.from('case_safeguarding_assessments').select('id,immediate_danger,risk_summary,assessed_by,assessed_at').eq('case_id',caseId).order('assessed_at',{ascending:false}),
        admin.from('case_protective_actions').select('id,assessment_id,action_text,owner_text,initiated_at,status,completion_note,completed_at').eq('case_id',caseId).order('initiated_at'),
        admin.from('case_team_members').select('id,email,display_name,member_category,committee_role,nomination_status,linked_user_id,nominated_at,declaration_at').eq('case_id',caseId).neq('nomination_status','REVOKED').order('nominated_at'),
        admin.from('case_assignments').select('user_id,assignment_role,access_status').eq('case_id',caseId),
      ]);
      for(const result of q){if(result.error)throw result.error;}
      const assignments=q[5].data??[];const amap=new Map(assignments.map((a:any)=>[`${a.user_id}|${a.assignment_role}`,a.access_status]));
      return json({case:c,report:q[0].data,messages:q[1].data??[],assessments:q[2].data??[],protectiveActions:q[3].data??[],team:(q[4].data??[]).map((m:any)=>({...m,assignment_status:m.linked_user_id?(amap.get(`${m.linked_user_id}|${m.committee_role}`)??null):null}))});
    }

    if(action==='ASSESS_RISK'){
      const immediateDanger=body.immediateDanger===true;
      const riskSummary=text(body.riskSummary,10,5000);if(!riskSummary)return json({error:'Ringkasan assessment wajib 10–5.000 karakter.'},400);
      const{data,error}=await admin.rpc('hse_assess_risk_atomic',{p_case_id:caseId,p_actor_user_id:user.id,p_organization_id:orgId,p_immediate_danger:immediateDanger,p_risk_summary:riskSummary});
      if(error){const m=String(error.message??'');if(m.includes('ASSESSMENT_ALREADY_EXISTS'))return json({error:'Initial safeguarding assessment sudah tercatat.'},409);if(m.includes('FAST_LANE_NOT_ACTIVE'))return json({error:'Initial safeguarding assessment hanya dapat dilakukan setelah case dirujuk ke HSE.'},409);if(m.includes('RISK_SUMMARY_REQUIRED'))return json({error:'Ringkasan assessment wajib 10–5.000 karakter.'},400);if(m.includes('CASE_NOT_FOUND'))return json({error:'Case safeguarding tidak ditemukan.'},404);throw error;}
      return json(data);
    }

    if(action==='RECORD_PROTECTIVE_ACTION'){
      const actionText=text(body.actionText,10,5000);if(!actionText)return json({error:'Protective action wajib 10–5.000 karakter.'},400);
      const ownerText=text(body.ownerText,0,240);
      const{data,error}=await admin.rpc('hse_record_protective_action_atomic',{p_case_id:caseId,p_actor_user_id:user.id,p_organization_id:orgId,p_action_text:actionText,p_owner_text:ownerText});
      if(error){const m=String(error.message??'');if(m.includes('PROTECTIVE_GATE_NOT_ACTIVE'))return json({error:'Protective action gate tidak sedang aktif untuk case ini.'},409);if(m.includes('IMMEDIATE_DANGER_NOT_ASSESSED'))return json({error:'Assessment immediate danger belum tercatat.'},409);if(m.includes('PROTECTIVE_ACTION_REQUIRED'))return json({error:'Protective action wajib 10–5.000 karakter.'},400);if(m.includes('CASE_NOT_FOUND'))return json({error:'Case safeguarding tidak ditemukan.'},404);throw error;}
      return json(data);
    }

    if(action==='COMPLETE_PROTECTIVE_ACTION'){
      const id=String(body.protectiveActionId??''),note=text(body.completionNote,5,5000);if(!id||!note)return json({error:'Protective action dan catatan penyelesaian wajib diisi.'},400);
      const{data,error}=await admin.rpc('hse_complete_protective_action_atomic',{p_case_id:caseId,p_protective_action_id:id,p_actor_user_id:user.id,p_organization_id:orgId,p_completion_note:note});
      if(error){const m=String(error.message??'');if(m.includes('PROTECTIVE_ACTION_NOT_FOUND'))return json({error:'Protective action aktif tidak ditemukan.'},404);if(m.includes('PROTECTIVE_ACTION_NOT_ACTIVE'))return json({error:'Protective action ini sudah tidak aktif.'},409);if(m.includes('COMPLETION_NOTE_REQUIRED'))return json({error:'Protective action dan catatan penyelesaian wajib diisi.'},400);if(m.includes('CASE_NOT_FOUND'))return json({error:'Case safeguarding tidak ditemukan.'},404);throw error;}
      return json(data);
    }

    if(c.status!=='COMMITTEE_FORMATION')return json({error:'Pembentukan Tim Pemeriksa hanya dapat dilakukan setelah fast-lane gate selesai.'},409);

    if(action==='ADD_MEMBER'){
      const email=String(body.email??'').trim().toLowerCase(),displayName=text(body.displayName,0,200),memberCategory=String(body.memberCategory??''),committeeRole=String(body.committeeRole??''),rationale=text(body.rationale,5,5000),conflictContext=text(body.conflictContext,3,2000);
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!['DS','MANAGEMENT','STAFF','OTS','EXTERNAL'].includes(memberCategory)||!['CASE_LEAD','INVESTIGATOR','SUBJECT_MATTER_ADVISER'].includes(committeeRole)||!rationale||!conflictContext)return json({error:'Data kandidat belum lengkap/valid.'},400);
      const{data:m,error}=await admin.from('case_team_members').insert({case_id:caseId,email,display_name:displayName,member_category:memberCategory,committee_role:committeeRole,rationale,conflict_context:conflictContext,nomination_status:'PENDING_ACCOUNT',nominated_by:user.id}).select('id').single();
      if(error){if((error as any).code==='23505')return json({error:'Email ini sudah menjadi kandidat aktif pada case ini.'},409);throw error;}
      await admin.from('audit_logs').insert({organization_id:orgId,case_id:caseId,actor_user_id:user.id,event_type:'TEAM_MEMBER_NOMINATED',object_type:'case_team_member',object_id:m.id,details:{committee_role:committeeRole,authority_code:'HSE'}});
      return json({ok:true});
    }

    if(action==='REVOKE_MEMBER'){
      const memberId=String(body.memberId??''),now=new Date().toISOString();
      const{data:m}=await admin.from('case_team_members').select('linked_user_id').eq('id',memberId).eq('case_id',caseId).maybeSingle();if(!m)return json({error:'Kandidat tidak ditemukan.'},404);
      await admin.from('case_team_members').update({nomination_status:'REVOKED',revoked_at:now,updated_at:now}).eq('id',memberId);
      if(m.linked_user_id)await admin.from('case_assignments').update({access_status:'REVOKED',revoked_at:now}).eq('case_id',caseId).eq('user_id',m.linked_user_id);
      await admin.from('audit_logs').insert({organization_id:orgId,case_id:caseId,actor_user_id:user.id,event_type:'TEAM_MEMBER_REVOKED',object_type:'case_team_member',object_id:memberId,details:{authority_code:'HSE'}});
      return json({ok:true});
    }

    if(action==='ACTIVATE_TEAM'){
      const{data:a}=await admin.from('case_safeguarding_assessments').select('immediate_danger').eq('case_id',caseId).order('assessed_at',{ascending:false}).limit(1).maybeSingle();if(!a)return json({error:'Safeguarding assessment belum tercatat.'},409);
      if(a.immediate_danger){const{count}=await admin.from('case_protective_actions').select('id',{count:'exact',head:true}).eq('case_id',caseId);if(!count)return json({error:'Protective action wajib dicatat sebelum Tim Pemeriksa diaktifkan.'},409);}
      const{data:t,error}=await admin.from('case_team_members').select('linked_user_id,committee_role').eq('case_id',caseId).eq('nomination_status','CLEARED');if(error)throw error;
      const inv=(t??[]).filter((x:any)=>x.linked_user_id&&['CASE_LEAD','INVESTIGATOR'].includes(x.committee_role));const users=[...new Set(inv.map((x:any)=>x.linked_user_id))];
      if(users.length<2)return json({error:'Tim Pemeriksa membutuhkan minimum 2 orang berbeda yang telah lolos deklarasi benturan kepentingan.'},409);
      if(!inv.some((x:any)=>x.committee_role==='CASE_LEAD'))return json({error:'Tim Pemeriksa harus memiliki minimal satu Ketua Tim.'},409);
      const now=new Date().toISOString();
      await admin.from('case_assignments').update({access_status:'ACTIVE',revoked_at:null}).eq('case_id',caseId).in('user_id',users);
      await admin.from('cases').update({status:'INVESTIGATION',updated_at:now}).eq('id',caseId).eq('status','COMMITTEE_FORMATION');
      await admin.from('audit_logs').insert({organization_id:orgId,case_id:caseId,actor_user_id:user.id,event_type:'TEAM_ACTIVATED',object_type:'case',object_id:caseId,details:{authority_code:'HSE',investigator_count:users.length}});
      return json({ok:true,status:'INVESTIGATION',investigatorCount:users.length});
    }

    return json({error:'Aksi tidak dikenali.'},400);
  }catch(e){
    console.error('hse-case-action',e);
    const m=e instanceof Error?e.message:'';
    if(m==='UNAUTHENTICATED')return json({error:'Silakan masuk terlebih dahulu.'},401);
    if(m==='FORBIDDEN')return json({error:'Akun ini tidak memiliki kewenangan Otoritas Perlindungan.'},403);
    if(m==='CASE_NOT_FOUND')return json({error:'Case safeguarding tidak ditemukan.'},404);
    return json({error:'Aksi safeguarding belum dapat diproses.'},400);
  }
});