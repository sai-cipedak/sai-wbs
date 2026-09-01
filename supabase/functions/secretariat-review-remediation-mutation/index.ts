import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';

const cors={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
};
const admin=createClient(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',{auth:{persistSession:false,autoRefreshToken:false}});
const json=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
const ACTIONS=new Set(['REVIEW_FINDINGS','ADD_REMEDIATION_ACTION','COMPLETE_REMEDIATION_ACTION','WAIVE_REMEDIATION_ACTION']);

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

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'Metode tidak diizinkan.'},405);
  try{
    const u=await currentUser(req);
    const orgId=await secretariatOrg(u.id);
    const body=await req.json().catch(()=>({}));
    const action=String(body.action??'').toUpperCase();
    if(!ACTIONS.has(action))return json({error:'Aksi tidak dikenali.'},400);
    const caseId=String(body.caseId??'');
    if(!caseId)return json({error:'Case ID wajib.'},400);

    const requestedUat=body.uat===true;
    const allowUat=requestedUat&&await hasActiveRole(u.id,orgId,'SYSTEM_ADMIN');
    if(requestedUat&&!allowUat)return json({error:'Mode UAT hanya tersedia untuk SYSTEM_ADMIN aktif.'},403);
    const{data:caseRow,error:caseError}=await admin.from('cases').select('id,is_test_data').eq('id',caseId).eq('organization_id',orgId).maybeSingle();
    if(caseError)throw caseError;
    if(!caseRow||(caseRow.is_test_data&&!allowUat))return json({error:'Laporan tidak ditemukan.'},404);

    if(action==='REVIEW_FINDINGS'){
      const decision=String(body.decision??'').toUpperCase();
      const reviewNotes=String(body.reviewNotes??'').trim();
      if(!['APPROVED','RETURNED_FOR_REVISION'].includes(decision)||reviewNotes.length<5||reviewNotes.length>5000)return json({error:'Keputusan dan catatan review wajib diisi.'},400);
      const{data,error}=await admin.rpc('review_integrity_findings_atomic',{p_case_id:caseId,p_actor_user_id:u.id,p_organization_id:orgId,p_decision:decision,p_review_notes:reviewNotes});
      if(error){
        const m=error.message??'';
        if(m.includes('INCOMPLETE_FINDINGS'))return json({error:'Finding per dugaan belum lengkap.'},409);
        if(m.includes('CASE_CHANGED'))return json({error:'Hasil pemeriksaan tidak lagi berada pada tahap review Sekretariat.'},409);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Laporan tidak ditemukan.'},404);
        if(m.includes('INVALID_CLASSIFICATION'))return json({error:'Workflow review ini hanya berlaku untuk kasus Integritas.'},409);
        if(m.includes('REVIEW_NOTES_REQUIRED')||m.includes('INVALID_DECISION'))return json({error:'Keputusan dan catatan review wajib diisi.'},400);
        throw error;
      }
      return json(data);
    }

    if(action==='ADD_REMEDIATION_ACTION'){
      const actionText=String(body.actionText??'').trim();
      const ownerText=String(body.ownerText??'').trim().slice(0,240)||null;
      const dueDate=String(body.dueDate??'').trim()||null;
      if(actionText.length<5||actionText.length>5000)return json({error:'Tindak lanjut harus 5–5.000 karakter.'},400);
      if(dueDate&&!/^\d{4}-\d{2}-\d{2}$/.test(dueDate))return json({error:'Tanggal target tidak valid.'},400);
      const{data,error}=await admin.rpc('add_remediation_action_atomic',{p_case_id:caseId,p_actor_user_id:u.id,p_organization_id:orgId,p_action_text:actionText,p_owner_text:ownerText,p_due_date:dueDate});
      if(error){
        const m=error.message??'';
        if(m.includes('CASE_CHANGED'))return json({error:'Action item hanya dapat ditambah pada tahap Tindak Lanjut.'},409);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Laporan tidak ditemukan.'},404);
        if(m.includes('ACTION_TEXT_REQUIRED'))return json({error:'Tindak lanjut harus 5–5.000 karakter.'},400);
        throw error;
      }
      return json(data);
    }

    const remediationId=String(body.remediationId??'');
    const completionNote=String(body.completionNote??'').trim();
    if(!remediationId)return json({error:'Action item wajib dipilih.'},400);
    if(completionNote.length<5||completionNote.length>5000)return json({error:'Catatan penyelesaian/alasan waiver wajib 5–5.000 karakter.'},400);
    const finalStatus=action==='COMPLETE_REMEDIATION_ACTION'?'COMPLETED':'WAIVED';
    const{data,error}=await admin.rpc('finish_remediation_action_atomic',{p_case_id:caseId,p_remediation_id:remediationId,p_actor_user_id:u.id,p_organization_id:orgId,p_final_status:finalStatus,p_completion_note:completionNote});
    if(error){
      const m=error.message??'';
      if(m.includes('CASE_CHANGED'))return json({error:'Tindak lanjut tidak sedang aktif.'},409);
      if(m.includes('REMEDIATION_NOT_FOUND'))return json({error:'Action item tidak ditemukan.'},404);
      if(m.includes('REMEDIATION_ALREADY_FINISHED'))return json({error:'Action item ini sudah selesai atau di-waive.'},409);
      if(m.includes('CASE_NOT_FOUND'))return json({error:'Laporan tidak ditemukan.'},404);
      if(m.includes('COMPLETION_NOTE_REQUIRED'))return json({error:'Catatan penyelesaian/alasan waiver wajib 5–5.000 karakter.'},400);
      throw error;
    }
    return json(data);
  }catch(e){
    console.error('secretariat-review-remediation-mutation',e);
    const code=e instanceof Error?e.message:'';
    if(code==='UNAUTHENTICATED')return json({error:'Silakan masuk terlebih dahulu.'},401);
    if(code==='FORBIDDEN')return json({error:'Akun ini tidak memiliki kewenangan Sekretariat DS.'},403);
    return json({error:'Aksi review/tindak lanjut Sekretariat belum dapat diproses.'},400);
  }
});
