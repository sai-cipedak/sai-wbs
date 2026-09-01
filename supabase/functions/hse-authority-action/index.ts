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
  const{data,error}=await admin.from('user_system_roles').select('organization_id,active_from,active_until').eq('user_id',uid).eq('role_code','HSE').lte('active_from',now);
  if(error)throw error;
  for(const r of data??[]){
    if(r.active_until&&r.active_until<=now)continue;
    const{data:p}=await admin.from('profiles').select('is_active').eq('user_id',uid).eq('organization_id',r.organization_id).maybeSingle();
    if(p?.is_active)return String(r.organization_id);
  }
  throw new Error('FORBIDDEN');
}
async function hseCase(caseId:string|null,publicCaseId:string|null,orgId:string){
  let q=admin.from('cases').select('id,public_case_id,status,classification,authority_code,organization_id').eq('organization_id',orgId).eq('authority_code','HSE').eq('classification','SAFEGUARDING');
  q=caseId?q.eq('id',caseId):q.eq('public_case_id',publicCaseId??'');
  const{data,error}=await q.maybeSingle();
  if(error)throw error;
  if(!data)throw new Error('CASE_NOT_FOUND');
  return data;
}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'Metode tidak diizinkan.'},405);
  try{
    const user=await currentUser(req);
    const orgId=await hseOrg(user.id);
    const body=await req.json().catch(()=>({}));
    const action=String(body.action??'DETAIL').toUpperCase();
    const caseId=String(body.caseId??'').trim()||null;
    const publicCaseId=String(body.publicCaseId??'').trim()||null;
    if(!caseId&&!publicCaseId)return json({error:'Case ID atau nomor laporan wajib.'},400);
    const c=await hseCase(caseId,publicCaseId,orgId);
    const cid=String(c.id);

    if(action==='DETAIL'){
      const results=await Promise.all([
        admin.from('case_allegations').select('id,sequence_no,statement,status').eq('case_id',cid).eq('status','ACTIVE').order('sequence_no'),
        admin.from('case_findings').select('id,allegation_id,finding_status,analysis_text,recommendation_text,updated_at').eq('case_id',cid),
        admin.from('case_authority_reviews').select('id,decision,review_notes,created_at').eq('case_id',cid).order('created_at',{ascending:false}),
        admin.from('case_remediation_actions').select('id,action_text,owner_text,due_date,status,completion_note,created_at,updated_at,completed_at').eq('case_id',cid).order('created_at'),
        admin.from('case_protective_actions').select('id,action_text,owner_text,status,completion_note,initiated_at,completed_at').eq('case_id',cid).order('initiated_at'),
      ]);
      const firstError=results.find((x)=>x.error)?.error;
      if(firstError)throw firstError;
      const[allegations,findings,reviews,remediation,protective]=results.map((x)=>x.data);
      return json({caseId:cid,publicCaseId:c.public_case_id,caseStatus:c.status,allegations:allegations??[],findings:findings??[],reviews:reviews??[],remediation:remediation??[],protectiveActions:protective??[]});
    }

    if(action==='REVIEW_FINDINGS'){
      const decision=String(body.decision??'').toUpperCase();
      const notes=String(body.reviewNotes??'').trim();
      if(!['APPROVED','RETURNED_FOR_REVISION'].includes(decision)||notes.length<5||notes.length>5000)return json({error:'Keputusan dan catatan review HSE wajib diisi.'},400);
      const{data,error}=await admin.rpc('hse_review_findings_atomic',{p_case_id:cid,p_actor_user_id:user.id,p_organization_id:orgId,p_decision:decision,p_review_notes:notes});
      if(error){
        const m=String(error.message??'');
        if(m.includes('INCOMPLETE_FINDINGS'))return json({error:'Finding per dugaan belum lengkap.'},409);
        if(m.includes('CASE_CHANGED'))return json({error:'Hasil pemeriksaan belum berada pada tahap review HSE atau status case telah berubah.'},409);
        if(m.includes('INVALID_CLASSIFICATION'))return json({error:'Workflow review ini hanya berlaku untuk kasus safeguarding.'},409);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Case safeguarding tidak ditemukan.'},404);
        if(m.includes('INVALID_DECISION')||m.includes('REVIEW_NOTES_REQUIRED'))return json({error:'Keputusan dan catatan review HSE wajib diisi.'},400);
        throw error;
      }
      return json(data);
    }

    if(action==='ADD_REMEDIATION'){
      const actionText=String(body.actionText??'').trim();
      const ownerText=String(body.ownerText??'').trim().slice(0,500)||null;
      const dueDate=String(body.dueDate??'').trim()||null;
      if(actionText.length<5||actionText.length>5000)return json({error:'Tindak lanjut wajib 5–5.000 karakter.'},400);
      if(dueDate&&!/^\d{4}-\d{2}-\d{2}$/.test(dueDate))return json({error:'Format target tanggal tidak valid.'},400);
      const{data,error}=await admin.rpc('hse_add_remediation_action_atomic',{p_case_id:cid,p_actor_user_id:user.id,p_organization_id:orgId,p_action_text:actionText,p_owner_text:ownerText,p_due_date:dueDate});
      if(error){
        const m=String(error.message??'');
        if(m.includes('CASE_CHANGED'))return json({error:'Aksi tindak lanjut hanya tersedia pada tahap Tindak Lanjut.'},409);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Case safeguarding tidak ditemukan.'},404);
        if(m.includes('ACTION_TEXT_REQUIRED'))return json({error:'Tindak lanjut wajib 5–5.000 karakter.'},400);
        throw error;
      }
      return json(data);
    }

    if(action==='COMPLETE_REMEDIATION'){
      const id=String(body.remediationId??'');
      const note=String(body.completionNote??'').trim();
      const finalStatus=Boolean(body.waive)?'WAIVED':'COMPLETED';
      if(!id)return json({error:'Action item tidak ditemukan.'},400);
      if(note.length<5||note.length>5000)return json({error:'Catatan penyelesaian/waiver wajib 5–5.000 karakter.'},400);
      const{data,error}=await admin.rpc('hse_finish_remediation_action_atomic',{p_case_id:cid,p_remediation_id:id,p_actor_user_id:user.id,p_organization_id:orgId,p_final_status:finalStatus,p_completion_note:note});
      if(error){
        const m=String(error.message??'');
        if(m.includes('CASE_CHANGED'))return json({error:'Aksi tindak lanjut hanya tersedia pada tahap Tindak Lanjut.'},409);
        if(m.includes('REMEDIATION_NOT_FOUND'))return json({error:'Action item tidak ditemukan.'},404);
        if(m.includes('REMEDIATION_ALREADY_FINISHED'))return json({error:'Action item ini sudah selesai.'},409);
        if(m.includes('COMPLETION_NOTE_REQUIRED'))return json({error:'Catatan penyelesaian/waiver wajib 5–5.000 karakter.'},400);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Case safeguarding tidak ditemukan.'},404);
        throw error;
      }
      return json(data);
    }

    if(action==='CLOSE'){
      const internalSummary=String(body.internalSummary??'').trim();
      const reporterSummary=String(body.reporterSummary??'').trim();
      if(internalSummary.length<5||reporterSummary.length<5)return json({error:'Ringkasan internal dan ringkasan untuk pelapor wajib diisi.'},400);
      const{data,error}=await admin.rpc('close_case_remediation',{p_case_id:cid,p_actor_user_id:user.id,p_organization_id:orgId,p_internal_summary:internalSummary,p_reporter_summary:reporterSummary});
      if(error){
        const m=String(error.message??'');
        if(m.includes('PENDING_REMEDIATION'))return json({error:'Masih ada tindak lanjut yang belum selesai atau di-waive.'},409);
        if(m.includes('ACTIVE_PROTECTIVE_ACTION'))return json({error:'Protective action safeguarding masih ACTIVE. Tandai selesai sebelum menutup case.'},409);
        if(m.includes('NOT_IN_REMEDIATION'))return json({error:'Case sudah tidak berada pada tahap Tindak Lanjut.'},409);
        console.error(error);
        return json({error:'Case safeguarding belum dapat ditutup.'},409);
      }
      return json(data);
    }

    return json({error:'Aksi tidak dikenali.'},400);
  }catch(e){
    console.error('hse-authority-action',e);
    const m=e instanceof Error?e.message:'';
    if(m==='UNAUTHENTICATED')return json({error:'Silakan masuk terlebih dahulu.'},401);
    if(m==='FORBIDDEN')return json({error:'Akun ini tidak memiliki kewenangan Otoritas Perlindungan.'},403);
    if(m==='CASE_NOT_FOUND')return json({error:'Case safeguarding tidak ditemukan.'},404);
    return json({error:'Aksi otoritas safeguarding belum dapat diproses.'},400);
  }
});