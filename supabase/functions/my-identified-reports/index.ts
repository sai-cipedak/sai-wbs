import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';
import { corsHeaders } from '../_shared/cors.ts';
import { CLASSIFICATION_LABELS, jsonResponse, STATUS_LABELS } from '../_shared/intake.ts';

const admin=createClient(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',{auth:{persistSession:false,autoRefreshToken:false}});
const OUTCOME_LABELS:Record<string,string>={PROVEN:'Terbukti',PARTIALLY_PROVEN:'Sebagian Terbukti',NOT_PROVEN:'Tidak Terbukti',INCONCLUSIVE:'Tidak Dapat Disimpulkan',NOT_EXAMINABLE:'Tidak Dapat Diperiksa',OUT_OF_SCOPE:'Di Luar Ruang Lingkup'};

Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
 if(req.method!=='GET'&&req.method!=='POST')return jsonResponse({error:'Metode tidak diizinkan.'},405,corsHeaders);
 try{
  const token=(req.headers.get('Authorization')??'').replace(/^Bearer\s+/i,'');
  if(!token)return jsonResponse({error:'Silakan masuk terlebih dahulu.'},401,corsHeaders);
  const{data:userResult,error:userError}=await admin.auth.getUser(token);const user=userResult.user;
  if(userError||!user)return jsonResponse({error:'Sesi tidak valid. Silakan masuk kembali.'},401,corsHeaders);
  const{data:cases,error:caseError}=await admin.from('cases').select('id,public_case_id,status,classification,submitted_at,closed_at,is_test_data,test_label').eq('created_by_user_id',user.id).eq('reporting_mode','IDENTIFIED').order('submitted_at',{ascending:false});
  if(caseError)throw caseError;
  const ids=(cases??[]).map((r:any)=>r.id);if(!ids.length)return jsonResponse({laporan:[]},200,corsHeaders);
  const[{data:reports,error:reportError},{data:messages,error:messageError},{data:closures,error:closureError}]=await Promise.all([
   admin.from('case_reports').select('case_id,title').in('case_id',ids),
   admin.from('case_messages').select('id,case_id,sender_type,body,created_at').in('case_id',ids).eq('visible_to_reporter',true).order('created_at',{ascending:true}),
   admin.from('case_closures').select('case_id,closure_no,reporter_summary,reporter_outcomes,created_at').in('case_id',ids).order('closure_no',{ascending:false})
  ]);
  if(reportError||messageError||closureError)throw reportError||messageError||closureError;
  const titleByCase=new Map((reports??[]).map((r:any)=>[r.case_id,r.title]));
  const messagesByCase=new Map<string,any[]>();for(const row of messages??[]){const list=messagesByCase.get(row.case_id)??[];list.push({id:row.id,dari:row.sender_type==='REPORTER'?'Anda':row.sender_type==='SYSTEM'?'Sistem':'Tim Penanganan',isi:row.body,waktu:row.created_at});messagesByCase.set(row.case_id,list);}
  const closureByCase=new Map<string,any>();for(const row of closures??[]){if(!closureByCase.has(row.case_id))closureByCase.set(row.case_id,row);}
  return jsonResponse({laporan:(cases??[]).map((row:any)=>{const closure=closureByCase.get(row.id);const outcomes=Array.isArray(closure?.reporter_outcomes)?closure.reporter_outcomes.map((x:any)=>({sequenceNo:x.sequenceNo,outcome:x.outcome,label:OUTCOME_LABELS[x.outcome]??x.outcome})):[];return{id:row.id,nomorLaporan:row.public_case_id,judul:titleByCase.get(row.id)??'Laporan',status:STATUS_LABELS[row.status]??'Sedang Ditangani',statusCode:row.status,klasifikasi:row.classification?(CLASSIFICATION_LABELS[row.classification]??null):null,tanggalLaporan:row.submitted_at,closedAt:row.closed_at,pesan:messagesByCase.get(row.id)??[],hasilAkhir:closure?{ringkasan:closure.reporter_summary,outcomes,waktu:closure.created_at,closureNo:closure.closure_no}:null,isTestData:row.is_test_data===true,testLabel:row.test_label??null,canMessage:!['CLOSED','OUT_OF_SCOPE'].includes(row.status)};})},200,corsHeaders);
 }catch(error){console.error('my-identified-reports',error);return jsonResponse({error:'Daftar laporan belum dapat dimuat.'},400,corsHeaders);}
});
