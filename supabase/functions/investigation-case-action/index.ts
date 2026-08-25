import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession:false, autoRefreshToken:false } });
const json = (body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});

async function requireUser(req:Request){
  const token=(req.headers.get('Authorization')??'').replace(/^Bearer\s+/i,'');
  if(!token) throw new Error('UNAUTHENTICATED');
  const {data,error}=await admin.auth.getUser(token);
  if(error||!data.user) throw new Error('UNAUTHENTICATED');
  return data.user;
}

async function assignment(caseId:string,userId:string){
  const {data,error}=await admin.from('case_assignments').select('assignment_role,access_status').eq('case_id',caseId).eq('user_id',userId).eq('access_status','ACTIVE');
  if(error) throw error;
  const a=(data??[]).find((x)=>['CASE_LEAD','INVESTIGATOR','SUBJECT_MATTER_ADVISER'].includes(x.assignment_role));
  if(!a) throw new Error('FORBIDDEN');
  return a.assignment_role as string;
}

async function getCase(caseId:string){
  const {data,error}=await admin.from('cases').select('id,organization_id,public_case_id,reporting_mode,status,classification,authority_code,submitted_at,updated_at').eq('id',caseId).single();
  if(error||!data) throw new Error('CASE_NOT_FOUND');
  return data;
}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  if(req.method!=='POST') return json({error:'Metode tidak diizinkan.'},405);
  try{
    const user=await requireUser(req);
    const body=await req.json().catch(()=>({}));
    const action=String(body.action??'LIST');

    if(action==='LIST'){
      const {data:assignments,error}=await admin.from('case_assignments').select('case_id,assignment_role').eq('user_id',user.id).eq('access_status','ACTIVE').in('assignment_role',['CASE_LEAD','INVESTIGATOR','SUBJECT_MATTER_ADVISER']);
      if(error) throw error;
      const ids=[...new Set((assignments??[]).map((a)=>a.case_id))];
      if(!ids.length) return json({cases:[]});
      const {data:cases,error:caseError}=await admin.from('cases').select('id,public_case_id,status,classification,submitted_at').in('id',ids).in('status',['INVESTIGATION','AUTHORITY_REVIEW']).order('submitted_at',{ascending:false});
      if(caseError) throw caseError;
      const caseIds=(cases??[]).map((c)=>c.id);
      const {data:reports}=caseIds.length?await admin.from('case_reports').select('case_id,title').in('case_id',caseIds):{data:[]} as any;
      const titleMap=new Map((reports??[]).map((r:any)=>[r.case_id,r.title]));
      const roleMap=new Map((assignments??[]).map((a)=>[a.case_id,a.assignment_role]));
      return json({cases:(cases??[]).map((c)=>({...c,title:titleMap.get(c.id)??c.public_case_id,assignmentRole:roleMap.get(c.id)}))});
    }

    const caseId=String(body.caseId??'');
    if(!caseId) return json({error:'Case ID wajib.'},400);
    const role=await assignment(caseId,user.id);
    const c=await getCase(caseId);

    if(action==='DETAIL'){
      const [{data:report},{data:messages},{data:notes},{data:allegations},{data:findings},{data:evidence}] = await Promise.all([
        admin.from('case_reports').select('*').eq('case_id',caseId).single(),
        admin.from('case_messages').select('id,sender_type,body,visible_to_reporter,created_at').eq('case_id',caseId).order('created_at',{ascending:true}),
        admin.from('case_investigation_notes').select('id,author_user_id,note_type,title,body,created_at,updated_at').eq('case_id',caseId).order('created_at',{ascending:false}),
        admin.from('case_allegations').select('id,sequence_no,statement,status,created_at,updated_at').eq('case_id',caseId).order('sequence_no',{ascending:true}),
        admin.from('case_findings').select('id,allegation_id,finding_status,analysis_text,recommendation_text,updated_by,updated_at').eq('case_id',caseId),
        admin.from('case_evidence').select('id,original_filename,mime_type,evidence_type,description,status,created_at').eq('case_id',caseId).order('created_at',{ascending:true}),
      ]);
      return json({case:c,assignmentRole:role,report,messages:messages??[],notes:notes??[],allegations:allegations??[],findings:findings??[],evidence:evidence??[]});
    }

    if(c.status!=='INVESTIGATION') return json({error:'Laporan tidak sedang berada pada tahap Pemeriksaan.'},409);

    if(action==='ADD_NOTE'){
      const noteType=String(body.noteType??'GENERAL');
      const title=String(body.title??'').trim().slice(0,240)||null;
      const noteBody=String(body.body??'').trim();
      if(!['GENERAL','INTERVIEW','EVIDENCE','ANALYSIS'].includes(noteType)) return json({error:'Jenis catatan tidak valid.'},400);
      if(noteBody.length<3||noteBody.length>10000) return json({error:'Isi catatan harus 3–10.000 karakter.'},400);
      const {data:note,error}=await admin.from('case_investigation_notes').insert({case_id:caseId,author_user_id:user.id,note_type:noteType,title,body:noteBody}).select('id,note_type,title,body,created_at').single();
      if(error) throw error;
      await admin.from('audit_logs').insert({organization_id:c.organization_id,case_id:caseId,actor_user_id:user.id,event_type:'INVESTIGATION_NOTE_ADDED',object_type:'case_investigation_note',object_id:note.id,details:{note_type:noteType}});
      return json({ok:true,note});
    }

    if(action==='SEND_REPORTER_MESSAGE'){
      if(!['CASE_LEAD','INVESTIGATOR'].includes(role)) return json({error:'Peran ini tidak dapat mengirim pesan kepada pelapor.'},403);
      const message=String(body.message??'').trim();
      if(message.length<3||message.length>5000) return json({error:'Pesan harus 3–5.000 karakter.'},400);
      const {data:msg,error}=await admin.from('case_messages').insert({case_id:caseId,sender_type:'INTERNAL',sender_user_id:user.id,body:message,visible_to_reporter:true}).select('id,created_at').single();
      if(error) throw error;
      await admin.from('audit_logs').insert({organization_id:c.organization_id,case_id:caseId,actor_user_id:user.id,event_type:'INVESTIGATION_REPORTER_MESSAGE_SENT',object_type:'case_message',object_id:msg.id,details:{}});
      return json({ok:true});
    }

    if(action==='SAVE_ALLEGATION'){
      if(role!=='CASE_LEAD') return json({error:'Hanya Ketua Tim yang dapat menetapkan atau mengubah dugaan pemeriksaan.'},403);
      const statement=String(body.statement??'').trim();
      const allegationId=String(body.allegationId??'').trim()||null;
      if(statement.length<5||statement.length>2000) return json({error:'Rumusan dugaan harus 5–2.000 karakter.'},400);
      if(allegationId){
        const {data,error}=await admin.from('case_allegations').update({statement,updated_at:new Date().toISOString()}).eq('id',allegationId).eq('case_id',caseId).select('id,sequence_no,statement,status').single();
        if(error||!data) return json({error:'Dugaan tidak ditemukan.'},404);
        await admin.from('audit_logs').insert({organization_id:c.organization_id,case_id:caseId,actor_user_id:user.id,event_type:'ALLEGATION_UPDATED',object_type:'case_allegation',object_id:data.id,details:{sequence_no:data.sequence_no}});
        return json({ok:true,allegation:data});
      }
      const {data:maxRow}=await admin.from('case_allegations').select('sequence_no').eq('case_id',caseId).order('sequence_no',{ascending:false}).limit(1).maybeSingle();
      const sequenceNo=(maxRow?.sequence_no??0)+1;
      const {data,error}=await admin.from('case_allegations').insert({case_id:caseId,sequence_no:sequenceNo,statement,created_by:user.id}).select('id,sequence_no,statement,status').single();
      if(error) throw error;
      await admin.from('audit_logs').insert({organization_id:c.organization_id,case_id:caseId,actor_user_id:user.id,event_type:'ALLEGATION_ADDED',object_type:'case_allegation',object_id:data.id,details:{sequence_no:sequenceNo}});
      return json({ok:true,allegation:data});
    }

    if(action==='SAVE_FINDING'){
      if(!['CASE_LEAD','INVESTIGATOR'].includes(role)) return json({error:'Peran ini tidak dapat menyimpan hasil pemeriksaan.'},403);
      const allegationId=String(body.allegationId??'');
      const findingStatus=String(body.findingStatus??'');
      const analysisText=String(body.analysisText??'').trim();
      const recommendationText=String(body.recommendationText??'').trim().slice(0,5000)||null;
      if(!['PROVEN','PARTIALLY_PROVEN','NOT_PROVEN','INCONCLUSIVE','NOT_EXAMINABLE','OUT_OF_SCOPE'].includes(findingStatus)) return json({error:'Status hasil pemeriksaan tidak valid.'},400);
      if(analysisText.length<20||analysisText.length>10000) return json({error:'Analisis hasil pemeriksaan harus 20–10.000 karakter.'},400);
      const {data:allegation}=await admin.from('case_allegations').select('id').eq('id',allegationId).eq('case_id',caseId).eq('status','ACTIVE').maybeSingle();
      if(!allegation) return json({error:'Dugaan aktif tidak ditemukan.'},404);
      const now=new Date().toISOString();
      const {data,error}=await admin.from('case_findings').upsert({case_id:caseId,allegation_id:allegationId,finding_status:findingStatus,analysis_text:analysisText,recommendation_text:recommendationText,updated_by:user.id,updated_at:now},{onConflict:'case_id,allegation_id'}).select('id,allegation_id,finding_status,analysis_text,recommendation_text,updated_at').single();
      if(error) throw error;
      await admin.from('audit_logs').insert({organization_id:c.organization_id,case_id:caseId,actor_user_id:user.id,event_type:'FINDING_SAVED',object_type:'case_finding',object_id:data.id,details:{finding_status:findingStatus}});
      return json({ok:true,finding:data});
    }

    if(action==='SUBMIT_FINDINGS'){
      if(role!=='CASE_LEAD') return json({error:'Hanya Ketua Tim yang dapat mengirim hasil pemeriksaan ke Sekretariat.'},403);
      const {data:allegations,error:aError}=await admin.from('case_allegations').select('id,sequence_no').eq('case_id',caseId).eq('status','ACTIVE');
      if(aError) throw aError;
      if(!(allegations??[]).length) return json({error:'Minimal satu dugaan pemeriksaan harus dibuat sebelum hasil dikirim.'},409);
      const {data:findings,error:fError}=await admin.from('case_findings').select('allegation_id').eq('case_id',caseId);
      if(fError) throw fError;
      const completed=new Set((findings??[]).map((f)=>f.allegation_id));
      const missing=(allegations??[]).filter((a)=>!completed.has(a.id)).map((a)=>a.sequence_no);
      if(missing.length) return json({error:`Hasil belum lengkap untuk dugaan nomor ${missing.join(', ')}.`},409);
      const now=new Date().toISOString();
      await admin.from('cases').update({status:'AUTHORITY_REVIEW',updated_at:now}).eq('id',caseId);
      await admin.from('audit_logs').insert({organization_id:c.organization_id,case_id:caseId,actor_user_id:user.id,event_type:'FINDINGS_SUBMITTED_TO_AUTHORITY',object_type:'case',object_id:caseId,details:{allegation_count:(allegations??[]).length}});
      return json({ok:true,nomorLaporan:c.public_case_id,status:'AUTHORITY_REVIEW'});
    }

    return json({error:'Aksi tidak dikenali.'},400);
  }catch(error){
    console.error('investigation-case-action',error);
    const code=error instanceof Error?error.message:'';
    if(code==='UNAUTHENTICATED') return json({error:'Silakan masuk terlebih dahulu.'},401);
    if(code==='FORBIDDEN') return json({error:'Akses pemeriksaan belum aktif untuk akun ini.'},403);
    if(code==='CASE_NOT_FOUND') return json({error:'Laporan tidak ditemukan.'},404);
    return json({error:'Aksi pemeriksaan belum dapat diproses.'},400);
  }
});
