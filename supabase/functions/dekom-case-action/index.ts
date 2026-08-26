import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'};
const admin=createClient(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',{auth:{persistSession:false,autoRefreshToken:false}});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
async function currentUser(req:Request){const token=(req.headers.get('Authorization')??'').replace(/^Bearer\s+/i,'');if(!token)throw new Error('UNAUTHENTICATED');const{data,error}=await admin.auth.getUser(token);if(error||!data.user)throw new Error('UNAUTHENTICATED');return data.user;}
async function dekomOrg(uid:string){const now=new Date().toISOString();const{data,error}=await admin.from('user_system_roles').select('organization_id,active_from,active_until').eq('user_id',uid).eq('role_code','DEKOM').lte('active_from',now);if(error)throw error;const row=(data??[]).find((r:any)=>!r.active_until||r.active_until>now);if(!row)throw new Error('FORBIDDEN');return String(row.organization_id);}
Deno.serve(async(req)=>{if(req.method==='OPTIONS')return new Response('ok',{headers:cors});if(req.method!=='POST')return json({error:'Metode tidak diizinkan.'},405);try{const user=await currentUser(req),orgId=await dekomOrg(user.id),body=await req.json().catch(()=>({})),action=String(body.action??'LIST');
if(action==='LIST'){
 const{data:cases,error}=await admin.from('cases').select('id,public_case_id,status,classification,priority,submitted_at,updated_at').eq('organization_id',orgId).eq('authority_code','DEKOM').neq('status','CLOSED').neq('status','OUT_OF_SCOPE').order('updated_at',{ascending:false});if(error)throw error;
 const ids=(cases??[]).map((c:any)=>c.id);if(!ids.length)return json({cases:[]});
 const[{data:reports},{data:acks}]=await Promise.all([admin.from('case_reports').select('case_id,title').in('case_id',ids),admin.from('case_dekom_acknowledgements').select('case_id,acknowledged_at').in('case_id',ids)]);
 const tm=new Map((reports??[]).map((r:any)=>[r.case_id,r.title])),am=new Map((acks??[]).map((a:any)=>[a.case_id,a.acknowledged_at]));
 return json({cases:(cases??[]).map((c:any)=>({...c,title:tm.get(c.id)??c.public_case_id,acknowledged_at:am.get(c.id)??null}))});
}
const caseId=String(body.caseId??'');if(!caseId)return json({error:'Case ID wajib.'},400);
const{data:c,error:ce}=await admin.from('cases').select('id,public_case_id,status,classification,priority,authority_code,submitted_at,updated_at').eq('id',caseId).eq('organization_id',orgId).eq('authority_code','DEKOM').single();if(ce||!c)return json({error:'Kasus Dekom tidak ditemukan.'},404);
if(action==='DETAIL'){
 const[{data:report},{data:ack},{data:link}]=await Promise.all([
  admin.from('case_reports').select('title,narrative,child_safety_risk,ongoing_risk,submitted_at').eq('case_id',caseId).single(),
  admin.from('case_dekom_acknowledgements').select('id,acknowledgement_note,acknowledged_at,acknowledged_by').eq('case_id',caseId).maybeSingle(),
  admin.from('case_links').select('source_case_id,source_followup_id,relation_type').eq('linked_case_id',caseId).eq('relation_type','RETALIATION_FOLLOWUP').maybeSingle()
 ]);
 let source=null;
 if(link){const[{data:sc},{data:fu}]=await Promise.all([admin.from('cases').select('public_case_id').eq('id',link.source_case_id).maybeSingle(),admin.from('case_followups').select('day_offset,outcome,risk_level,escalation_status,notes,escalation_note').eq('id',link.source_followup_id).maybeSingle()]);source={public_case_id:sc?.public_case_id??null,followup:fu??null};}
 return json({case:c,report,acknowledgement:ack??null,source});
}
if(action==='ACKNOWLEDGE'){
 const note=String(body.note??'').trim();if(note.length<5||note.length>5000)return json({error:'Catatan penerimaan wajib 5–5.000 karakter.'},400);
 const{data,error}=await admin.rpc('acknowledge_dekom_takeover',{p_case_id:caseId,p_actor_user_id:user.id,p_organization_id:orgId,p_note:note});if(error){console.error(error);return json({error:'Pengambilalihan belum dapat diterima.'},409);}return json(data);
}
return json({error:'Aksi tidak dikenali.'},400);
}catch(e){console.error(e);const m=e instanceof Error?e.message:'';if(m==='UNAUTHENTICATED')return json({error:'Silakan masuk terlebih dahulu.'},401);if(m==='FORBIDDEN')return json({error:'Akun ini tidak memiliki kewenangan Dekom.'},403);return json({error:'Workspace Dekom belum dapat diproses.'},400);}});
