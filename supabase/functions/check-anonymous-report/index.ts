import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';
import { corsHeaders } from '../_shared/cors.ts';
import { CLASSIFICATION_LABELS, jsonResponse, sha256Base64, STATUS_LABELS } from '../_shared/intake.ts';

const admin=createClient(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',{auth:{persistSession:false,autoRefreshToken:false}});
const OUTCOME:Record<string,string>={PROVEN:'Terbukti',PARTIALLY_PROVEN:'Sebagian Terbukti',NOT_PROVEN:'Tidak Terbukti',INCONCLUSIVE:'Tidak Dapat Disimpulkan',NOT_EXAMINABLE:'Tidak Dapat Diperiksa',OUT_OF_SCOPE:'Di Luar Ruang Lingkup'};

Deno.serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:corsHeaders});
  if(req.method!=='POST')return jsonResponse({error:'Metode tidak diizinkan.'},405,corsHeaders);
  try{
    const b=await req.json() as Record<string,unknown>;
    const num=String(b.nomorLaporan??'').trim().toUpperCase();
    const key=String(b.kunciRahasia??'').trim().toUpperCase();
    if(!num||!key)return jsonResponse({error:'Nomor Laporan dan Kunci Rahasia wajib diisi.'},400,corsHeaders);

    const{data:c}=await admin.from('cases').select('id,public_case_id,status,classification,submitted_at,closed_at,reporting_mode').eq('public_case_id',num).eq('reporting_mode','ANONYMOUS').maybeSingle();
    if(!c)return jsonResponse({error:'Nomor Laporan atau Kunci Rahasia tidak sesuai.'},403,corsHeaders);

    const hash=await sha256Base64(key);
    const{data:access,error:accessError}=await admin.rpc('verify_anonymous_access_atomic',{p_case_id:c.id,p_supplied_hash:hash});
    if(accessError)throw accessError;
    if(!access?.ok){
      if(access?.code==='LOCKED')return jsonResponse({error:'Akses sementara dikunci karena terlalu banyak percobaan. Coba lagi beberapa saat lagi.'},429,corsHeaders);
      return jsonResponse({error:'Nomor Laporan atau Kunci Rahasia tidak sesuai.'},403,corsHeaders);
    }

    const[{data:r},{data:m}]=await Promise.all([
      admin.from('case_reports').select('title').eq('case_id',c.id).single(),
      admin.from('case_messages').select('id,sender_type,body,created_at').eq('case_id',c.id).eq('visible_to_reporter',true).order('created_at'),
    ]);
    let closure:any=null;
    if(c.status==='CLOSED'){
      const{data}=await admin.from('case_closures').select('closure_no,reporter_summary,reporter_outcomes,created_at').eq('case_id',c.id).order('closure_no',{ascending:false}).limit(1).maybeSingle();
      closure=data;
    }
    const outcomes=Array.isArray(closure?.reporter_outcomes)?closure.reporter_outcomes:[];
    return jsonResponse({
      nomorLaporan:c.public_case_id,
      judul:r?.title??'Laporan',
      status:STATUS_LABELS[c.status]??'Sedang Ditangani',
      statusCode:c.status,
      klasifikasi:c.classification?(CLASSIFICATION_LABELS[c.classification]??null):null,
      tanggalLaporan:c.submitted_at,
      canReply:!['CLOSED','OUT_OF_SCOPE'].includes(c.status),
      hasilAkhir:closure?{ringkasan:closure.reporter_summary,waktu:closure.created_at,hasil:outcomes.map((x:any)=>({dugaan:Number(x.sequenceNo),hasil:OUTCOME[String(x.outcome)]??String(x.outcome)}))}:null,
      pesan:(m??[]).map(x=>({id:x.id,dari:x.sender_type==='REPORTER'?'Anda':x.sender_type==='SYSTEM'?'Sistem':'Tim Penanganan',isi:x.body,waktu:x.created_at})),
    },200,corsHeaders);
  }catch(e){
    console.error('check-anonymous-report',e);
    return jsonResponse({error:'Perkembangan laporan belum dapat dimuat.'},400,corsHeaders);
  }
});
