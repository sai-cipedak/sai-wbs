import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';

const cors={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
};
const admin=createClient(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',{auth:{persistSession:false,autoRefreshToken:false}});
const json=(b:unknown,s=200)=>new Response(JSON.stringify(b),{status:s,headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});

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
    if(!['ADD_MEMBER','REVOKE_MEMBER','ACTIVATE_TEAM'].includes(action))return json({error:'Aksi tidak dikenali.'},400);
    const caseId=String(body.caseId??'');
    if(!caseId)return json({error:'Case ID wajib.'},400);

    const requestedUat=body.uat===true;
    const allowUat=requestedUat&&await hasActiveRole(u.id,orgId,'SYSTEM_ADMIN');
    if(requestedUat&&!allowUat)return json({error:'Mode UAT hanya tersedia untuk SYSTEM_ADMIN aktif.'},403);
    const{data:caseRow,error:caseError}=await admin.from('cases').select('id,is_test_data').eq('id',caseId).eq('organization_id',orgId).maybeSingle();
    if(caseError)throw caseError;
    if(!caseRow||(caseRow.is_test_data&&!allowUat))return json({error:'Laporan tidak ditemukan.'},404);

    if(action==='ADD_MEMBER'){
      const email=String(body.email??'').trim().toLowerCase();
      const displayName=String(body.displayName??'').trim().slice(0,200)||null;
      const memberCategory=String(body.memberCategory??'');
      const committeeRole=String(body.committeeRole??'');
      const rationale=String(body.rationale??'').trim();
      const conflictContext=String(body.conflictContext??'').trim();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!['DS','MANAGEMENT','STAFF','OTS','EXTERNAL'].includes(memberCategory)||!['CASE_LEAD','INVESTIGATOR','SUBJECT_MATTER_ADVISER'].includes(committeeRole)||rationale.length<5||conflictContext.length<3){
        return json({error:'Data kandidat belum lengkap/valid.'},400);
      }
      const{data,error}=await admin.rpc('add_case_team_member_atomic',{
        p_case_id:caseId,p_actor_user_id:u.id,p_organization_id:orgId,p_email:email,p_display_name:displayName,
        p_member_category:memberCategory,p_committee_role:committeeRole,p_rationale:rationale,p_conflict_context:conflictContext,
      });
      if(error){
        if((error as any).code==='23505')return json({error:'Email ini sudah menjadi kandidat aktif pada laporan ini.'},409);
        const m=error.message??'';
        if(m.includes('TEAM_FORMATION_NOT_ACTIVE'))return json({error:'Pembentukan tim hanya dapat diubah saat status Menunggu Pembentukan Tim.'},409);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Laporan tidak ditemukan.'},404);
        if(m.includes('INVALID_'))return json({error:'Data kandidat belum lengkap/valid.'},400);
        throw error;
      }
      return json(data);
    }

    if(action==='REVOKE_MEMBER'){
      const memberId=String(body.memberId??'');
      if(!memberId)return json({error:'Kandidat wajib dipilih.'},400);
      const{data,error}=await admin.rpc('revoke_case_team_member_atomic',{p_case_id:caseId,p_member_id:memberId,p_actor_user_id:u.id,p_organization_id:orgId});
      if(error){
        const m=error.message??'';
        if(m.includes('TEAM_MEMBER_NOT_FOUND'))return json({error:'Kandidat tidak ditemukan.'},404);
        if(m.includes('TEAM_MEMBER_ALREADY_REVOKED'))return json({error:'Penunjukan kandidat ini sudah dicabut.'},409);
        if(m.includes('TEAM_FORMATION_NOT_ACTIVE'))return json({error:'Pembentukan tim hanya dapat diubah saat status Menunggu Pembentukan Tim.'},409);
        if(m.includes('CASE_NOT_FOUND'))return json({error:'Laporan tidak ditemukan.'},404);
        throw error;
      }
      return json(data);
    }

    const{data,error}=await admin.rpc('activate_case_team_atomic',{p_case_id:caseId,p_actor_user_id:u.id,p_organization_id:orgId});
    if(error){
      const m=error.message??'';
      if(m.includes('MINIMUM_TEAM_NOT_MET'))return json({error:'Tim Pemeriksa membutuhkan minimum 2 orang berbeda yang telah lolos deklarasi benturan kepentingan.'},409);
      if(m.includes('CASE_LEAD_REQUIRED'))return json({error:'Tim Pemeriksa harus memiliki minimal satu Ketua Tim.'},409);
      if(m.includes('TEAM_ASSIGNMENT_MISSING'))return json({error:'Ada anggota yang sudah CLEARED tetapi assignment case belum terbentuk. Muat ulang atau perbaiki assignment sebelum aktivasi.'},409);
      if(m.includes('TEAM_FORMATION_NOT_ACTIVE'))return json({error:'Pembentukan tim hanya dapat diubah saat status Menunggu Pembentukan Tim.'},409);
      if(m.includes('CASE_NOT_FOUND'))return json({error:'Laporan tidak ditemukan.'},404);
      throw error;
    }
    return json(data);
  }catch(e){
    console.error('secretariat-team-mutation',e);
    const code=e instanceof Error?e.message:'';
    if(code==='UNAUTHENTICATED')return json({error:'Silakan masuk terlebih dahulu.'},401);
    if(code==='FORBIDDEN')return json({error:'Akun ini tidak memiliki kewenangan Sekretariat DS.'},403);
    return json({error:'Aksi pembentukan Tim Pemeriksa belum dapat diproses.'},400);
  }
});
