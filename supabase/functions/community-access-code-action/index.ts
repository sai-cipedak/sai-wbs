import { createClient } from 'jsr:@supabase/supabase-js@2.112.4';

const cors={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
};
const admin=createClient(Deno.env.get('SUPABASE_URL')??'',Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'',{auth:{persistSession:false,autoRefreshToken:false}});
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json; charset=utf-8'}});
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ITERATIONS=100000;
const encoder=new TextEncoder();

async function currentUser(req:Request){
  const token=(req.headers.get('Authorization')??'').replace(/^Bearer\s+/i,'');
  if(!token)throw new Error('UNAUTHENTICATED');
  const{data,error}=await admin.auth.getUser(token);
  if(error||!data.user)throw new Error('UNAUTHENTICATED');
  return data.user;
}

async function adminOrg(userId:string){
  const now=new Date().toISOString();
  const{data:roles,error}=await admin.from('user_system_roles').select('organization_id,active_until').eq('user_id',userId).eq('role_code','SYSTEM_ADMIN').lte('active_from',now);
  if(error)throw error;
  for(const role of roles??[]){
    if(role.active_until&&role.active_until<=now)continue;
    const{data:profile}=await admin.from('profiles').select('is_active').eq('user_id',userId).eq('organization_id',role.organization_id).maybeSingle();
    if(profile?.is_active)return String(role.organization_id);
  }
  throw new Error('FORBIDDEN');
}

function bytesToBase64(bytes:Uint8Array){let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);}
function generateCode(){const bytes=crypto.getRandomValues(new Uint8Array(15));const raw=Array.from(bytes,b=>ALPHABET[b&31]).join('');return `SAI-${raw.slice(0,5)}-${raw.slice(5,10)}-${raw.slice(10,15)}`;}
async function deriveHash(code:string,salt:Uint8Array){
  const key=await crypto.subtle.importKey('raw',encoder.encode(code),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:ITERATIONS},key,256);
  return bytesToBase64(new Uint8Array(bits));
}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:cors});
  if(req.method!=='POST')return json({error:'Metode tidak diizinkan.'},405);
  try{
    const user=await currentUser(req);
    const orgId=await adminOrg(user.id);
    const body=await req.json().catch(()=>({}));
    const action=String(body.action??'LIST').toUpperCase();

    if(action==='LIST'){
      const{data:codes,error}=await admin.from('community_access_codes').select('id,label,valid_from,valid_until,is_active,created_by,created_at').eq('organization_id',orgId).order('created_at',{ascending:false});
      if(error)throw error;
      const creatorIds=[...new Set((codes??[]).map((x:any)=>x.created_by).filter(Boolean))];
      const{data:creators}=creatorIds.length?await admin.from('profiles').select('user_id,display_name,email').in('user_id',creatorIds):{data:[]} as any;
      const creatorMap=new Map((creators??[]).map((x:any)=>[x.user_id,x.display_name||x.email||'Administrator Sistem']));
      const now=Date.now();
      return json({codes:(codes??[]).map((row:any)=>{
        const starts=new Date(row.valid_from).getTime();
        const ends=row.valid_until?new Date(row.valid_until).getTime():Number.POSITIVE_INFINITY;
        const status=!row.is_active?'REVOKED':starts>now?'SCHEDULED':ends<=now?'EXPIRED':'ACTIVE';
        return{id:row.id,label:row.label,validFrom:row.valid_from,validUntil:row.valid_until,status,createdAt:row.created_at,createdBy:creatorMap.get(row.created_by)??'Administrator Sistem'};
      })});
    }

    if(action==='GENERATE'){
      const label=String(body.label??'').trim();
      if(label.length<3||label.length>160)return json({error:'Label harus 3–160 karakter.'},400);
      const validFromRaw=String(body.validFrom??'').trim();
      const validUntilRaw=String(body.validUntil??'').trim();
      const validFrom=validFromRaw?new Date(validFromRaw):new Date();
      const validUntil=validUntilRaw?new Date(validUntilRaw):null;
      if(Number.isNaN(validFrom.getTime())||!validUntil||Number.isNaN(validUntil.getTime())||validUntil.getTime()<=validFrom.getTime())return json({error:'Periode berlaku kode tidak valid.'},400);

      const code=generateCode();
      const salt=crypto.getRandomValues(new Uint8Array(16));
      const hashB64=await deriveHash(code,salt);
      const{data,error}=await admin.rpc('admin_create_community_access_code',{
        p_organization_id:orgId,
        p_label:label,
        p_salt_b64:bytesToBase64(salt),
        p_iterations:ITERATIONS,
        p_hash_b64:hashB64,
        p_valid_from:validFrom.toISOString(),
        p_valid_until:validUntil.toISOString(),
        p_created_by:user.id,
      });
      if(error)throw error;
      return json({ok:true,code,...(data??{})},201);
    }

    if(action==='REVOKE'){
      const codeId=String(body.codeId??'').trim();
      if(!UUID_RE.test(codeId))return json({error:'ID kode tidak valid.'},400);
      const{data,error}=await admin.rpc('admin_revoke_community_access_code',{p_organization_id:orgId,p_code_id:codeId,p_actor_user_id:user.id});
      if(error){if((error.message??'').includes('CODE_NOT_ACTIVE'))return json({error:'Kode sudah tidak aktif atau tidak ditemukan.'},404);throw error;}
      return json(data??{ok:true});
    }

    return json({error:'Aksi tidak dikenali.'},400);
  }catch(error){
    console.error('community-access-code-action',error);
    const message=error instanceof Error?error.message:'';
    if(message==='UNAUTHENTICATED')return json({error:'Silakan masuk terlebih dahulu.'},401);
    if(message==='FORBIDDEN')return json({error:'Akun ini tidak memiliki kewenangan Administrator Sistem.'},403);
    return json({error:'Pengelolaan Kode Akses Komunitas belum dapat diproses.'},400);
  }
});
