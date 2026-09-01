import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';

const cors={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
};
const admin=createClient(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',{auth:{persistSession:false,autoRefreshToken:false}});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
const clean=(v:unknown,min=5,max=5000)=>{const s=String(v??'').trim();return s.length>=min&&s.length<=max?s:null;};

async function currentUser(req:Request){
  const token=(req.headers.get('Authorization')??'').replace(/^Bearer\s+/i,'');
  if(!token)throw new Error('UNAUTHENTICATED');
  const{data,error}=await admin.auth.getUser(token);
  if(error||!data.user)throw new Error('UNAUTHENTICATED');
  return data.user;
}
async function orgFor(uid:string){
  const now=new Date().toISOString();
  const{data,error}=await admin.from('user_system_roles').select('organization_id,active_from,active_until').eq('user_id',uid).eq('role_code','GRIEVANCE_COORDINATOR').lte('active_from',now);
  if(error)throw error;
  for(const r of data??[]){
    if(r.active_until&&r.active_until<=now)continue;
    const{data:p}=await admin.from('profiles').select('is_active').eq('user_id',uid).eq('organization_id',r.organization_id).maybeSingle();
    if(p?.is_active)return String(r.organization_id);
  }
  throw new Error('FORBIDDEN');
}
async function getCase(id:string,orgId:string){
  const{data,error}=await admin.from('cases').select('id,public_case_id,status,classification,authority_code,reporting_mode,priority,submitted_at,updated_at,is_test_data').eq('id',id).eq('organization_id',orgId).eq('authority_code','GRIEVANCE').eq('classification','GRIEVANCE').maybeSingle();
  if(error)throw error;
  if(!data)throw new Error('CASE_NOT_FOUND');
  return data;
}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'Metode tidak diizinkan.'},405);
  try{
    const user=await currentUser(req);
    const orgId=await orgFor(user.id);
    const body=await req.json().catch(()=>({}));
    const action=String(body.action??'LIST').toUpperCase();

    if(action==='LIST'){
      const{data:cases,error}=await admin.from('cases').select('id,public_case_id,status,classification,priority,reporting_mode,submitted_at,updated_at').eq('organization_id',orgId).eq('authority_code','GRIEVANCE').eq('classification','GRIEVANCE').eq('is_test_data',false).neq('status','CLOSED').neq('status','OUT_OF_SCOPE').order('updated_at',{ascending:false});
      if(error)throw error;
      const ids=(cases??[]).map((c:any)=>c.id);
      const{data:reports,error:reportError}=ids.length?await admin.from('case_reports').select('case_id,title').in('case_id',ids):{data:[],error:null} as any;
      if(reportError)throw reportError;
      const titles=new Map((reports??[]).map((r:any)=>[r.case_id,r.title]));
      return json({cases:(cases??[]).map((c:any)=>({...c,title:titles.get(c.id)??c.public_case_id}))});
    }

    const caseId=String(body.caseId??'').trim();
    if(!caseId)return json({error:'Case ID wajib.'},400);
    const c=await getCase(caseId,orgId);

    if(action==='DETAIL'){
      const results=await Promise.all([
        admin.from('case_reports').select('title,narrative,incident_date,incident_time_text,location_text,people_involved_text,child_safety_risk,ongoing_risk,submitted_at').eq('case_id',caseId).single(),
        admin.from('case_grievance_reviews').select('id,assessment_summary,resolution_scope,created_at,updated_at').eq('case_id',caseId).maybeSingle(),
        admin.from('case_remediation_actions').select('id,action_text,owner_text,due_date,status,completion_note,created_at,updated_at,completed_at').eq('case_id',caseId).order('created_at'),
        admin.from('case_messages').select('id,sender_type,body,visible_to_reporter,created_at').eq('case_id',caseId).eq('visible_to_reporter',true).order('created_at'),
      ]);
      const firstError=results.find((x)=>x.error)?.error;
      if(firstError)throw firstError;
      return json({case:c,report:results[0].data,review:results[1].data??null,remediation:results[2].data??[],messages:results[3].data??[]});
    }

    if(action==='START_RESOLUTION'){
      const summary=clean(body.assessmentSummary,10);
      const scope=clean(body.resolutionScope,5,1000);
      if(!summary||!scope)return json({error:'Assessment dan ruang lingkup resolution wajib diisi.'},400);
      const{data,error}=await admin.rpc('grievance_start_resolution_atomic',{p_case_id:caseId,p_actor_user_id:user.id,p_organization_id:orgId,p_assessment_summary:summary,p_resolution_scope:scope});
      if(error){
        const m=String(error.message??'');
        if(m.includes('CASE_CHANGED'))return json({error:'Resolution hanya dapat dimulai dari status Sedang Ditangani.'},409);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Case pengaduan tidak ditemukan.'},404);
        if(m.includes('ASSESSMENT_REQUIRED')||m.includes('SCOPE_REQUIRED'))return json({error:'Assessment dan ruang lingkup resolution wajib diisi.'},400);
        throw error;
      }
      return json(data);
    }

    if(action==='SEND_MESSAGE'){
      const message=clean(body.message,5);
      if(!message)return json({error:'Pesan wajib 5–5.000 karakter.'},400);
      const{data,error}=await admin.rpc('grievance_send_message_atomic',{p_case_id:caseId,p_actor_user_id:user.id,p_organization_id:orgId,p_message:message});
      if(error){
        const m=String(error.message??'');
        if(m.includes('CASE_CHANGED'))return json({error:'Pesan tidak tersedia pada status ini.'},409);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Case pengaduan tidak ditemukan.'},404);
        if(m.includes('MESSAGE_REQUIRED'))return json({error:'Pesan wajib 5–5.000 karakter.'},400);
        throw error;
      }
      return json(data);
    }

    if(action==='ADD_ACTION'){
      const actionText=clean(body.actionText,5);
      const ownerText=String(body.ownerText??'').trim().slice(0,500)||null;
      const dueDate=String(body.dueDate??'').trim()||null;
      if(!actionText)return json({error:'Action plan wajib 5–5.000 karakter.'},400);
      if(dueDate&&!/^\d{4}-\d{2}-\d{2}$/.test(dueDate))return json({error:'Format target tanggal tidak valid.'},400);
      const{data,error}=await admin.rpc('grievance_add_action_atomic',{p_case_id:caseId,p_actor_user_id:user.id,p_organization_id:orgId,p_action_text:actionText,p_owner_text:ownerText,p_due_date:dueDate});
      if(error){
        const m=String(error.message??'');
        if(m.includes('CASE_CHANGED'))return json({error:'Action plan hanya tersedia pada tahap Tindak Lanjut.'},409);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Case pengaduan tidak ditemukan.'},404);
        if(m.includes('ACTION_TEXT_REQUIRED'))return json({error:'Action plan wajib 5–5.000 karakter.'},400);
        throw error;
      }
      return json(data);
    }

    if(action==='COMPLETE_ACTION'){
      const actionId=String(body.actionId??'').trim();
      const note=clean(body.completionNote,5);
      const finalStatus=Boolean(body.waive)?'WAIVED':'COMPLETED';
      if(!actionId||!note)return json({error:'Action dan catatan penyelesaian/waiver wajib diisi.'},400);
      const{data,error}=await admin.rpc('grievance_finish_action_atomic',{p_case_id:caseId,p_action_id:actionId,p_actor_user_id:user.id,p_organization_id:orgId,p_final_status:finalStatus,p_completion_note:note});
      if(error){
        const m=String(error.message??'');
        if(m.includes('CASE_CHANGED'))return json({error:'Action plan hanya tersedia pada tahap Tindak Lanjut.'},409);
        if(m.includes('ACTION_NOT_FOUND'))return json({error:'Action item tidak ditemukan.'},404);
        if(m.includes('ACTION_ALREADY_FINISHED'))return json({error:'Action item sudah selesai.'},409);
        if(m.includes('COMPLETION_NOTE_REQUIRED'))return json({error:'Action dan catatan penyelesaian/waiver wajib diisi.'},400);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Case pengaduan tidak ditemukan.'},404);
        throw error;
      }
      return json(data);
    }

    if(action==='RETURN_TO_TRIAGE'){
      const reason=clean(body.reason,10);
      if(!reason)return json({error:'Alasan pengembalian wajib minimal 10 karakter.'},400);
      const{data,error}=await admin.rpc('grievance_return_to_triage_atomic',{p_case_id:caseId,p_actor_user_id:user.id,p_organization_id:orgId,p_reason:reason});
      if(error){
        const m=String(error.message??'');
        if(m.includes('CASE_CHANGED'))return json({error:'Case hanya dapat dikembalikan ke Penelaah Awal sebelum resolution dimulai.'},409);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Case pengaduan tidak ditemukan.'},404);
        if(m.includes('REASON_REQUIRED'))return json({error:'Alasan pengembalian wajib minimal 10 karakter.'},400);
        throw error;
      }
      return json(data);
    }

    if(action==='ESCALATE_SAFEGUARDING'){
      const reason=clean(body.reason,10);
      if(!reason)return json({error:'Alasan eskalasi safeguarding wajib minimal 10 karakter.'},400);
      const{data,error}=await admin.rpc('grievance_escalate_safeguarding_atomic',{p_case_id:caseId,p_actor_user_id:user.id,p_organization_id:orgId,p_reason:reason});
      if(error){
        const m=String(error.message??'');
        if(m.includes('CASE_CHANGED'))return json({error:'Eskalasi safeguarding tidak tersedia pada status ini.'},409);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Case pengaduan tidak ditemukan.'},404);
        if(m.includes('REASON_REQUIRED'))return json({error:'Alasan eskalasi safeguarding wajib minimal 10 karakter.'},400);
        throw error;
      }
      return json(data);
    }

    if(action==='CLOSE'){
      const outcome=String(body.resolutionOutcome??'');
      const internal=clean(body.internalSummary,5);
      const reporter=clean(body.reporterSummary,5);
      if(!internal||!reporter)return json({error:'Ringkasan internal dan untuk pelapor wajib diisi.'},400);
      const{data,error}=await admin.rpc('close_grievance_case',{p_case_id:caseId,p_actor_user_id:user.id,p_organization_id:orgId,p_resolution_outcome:outcome,p_internal_summary:internal,p_reporter_summary:reporter});
      if(error){
        const m=String(error.message??'');
        if(m.includes('PENDING_REMEDIATION'))return json({error:'Masih ada action plan yang belum selesai atau di-waive.'},409);
        if(m.includes('RESOLUTION_ACTION_REQUIRED'))return json({error:'Minimal satu action plan diperlukan untuk outcome ini.'},409);
        if(m.includes('INVALID_RESOLUTION_OUTCOME'))return json({error:'Outcome penyelesaian tidak valid.'},400);
        if(m.includes('GRIEVANCE_FORBIDDEN'))return json({error:'Akun tidak memiliki kewenangan Koordinator Pengaduan.'},403);
        throw error;
      }
      return json(data);
    }

    return json({error:'Aksi tidak dikenali.'},400);
  }catch(e){
    console.error('grievance-case-action',e);
    const m=e instanceof Error?e.message:'';
    if(m==='UNAUTHENTICATED')return json({error:'Silakan masuk terlebih dahulu.'},401);
    if(m==='FORBIDDEN')return json({error:'Akun ini tidak memiliki kewenangan Koordinator Pengaduan.'},403);
    if(m==='CASE_NOT_FOUND')return json({error:'Case pengaduan tidak ditemukan.'},404);
    return json({error:'Aksi pengaduan belum dapat diproses.'},400);
  }
});