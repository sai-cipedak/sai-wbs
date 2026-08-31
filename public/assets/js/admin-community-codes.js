import { supabaseClient } from './supabase-client.js';

const form=document.querySelector('#communityCodeForm');
const list=document.querySelector('#communityCodeList');
const pageMessage=document.querySelector('#pageMessage');
const dialog=document.querySelector('#communityCodeDialog');
const codeText=document.querySelector('#generatedCommunityCode');
const codeMeta=document.querySelector('#generatedCommunityCodeMeta');
const copyButton=document.querySelector('#copyCommunityCode');
const closeButton=document.querySelector('#closeCommunityCodeDialog');

const fmt=value=>value?new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Jakarta'}).format(new Date(value)):'—';
function el(tag,text,cls){const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;}
function show(text,kind='info'){if(!pageMessage)return;pageMessage.textContent=text;pageMessage.className=`form-message internal-message ${kind}`;pageMessage.hidden=!text;}
async function invoke(body){const{data,error}=await supabaseClient.functions.invoke('community-access-code-action',{body});if(error){let message=error.message;try{const context=await error.context?.json();if(context?.error)message=context.error;}catch(_){}throw new Error(message||'Kode Akses Komunitas belum dapat dikelola.');}return data;}

const STATUS={ACTIVE:'Aktif',SCHEDULED:'Terjadwal',EXPIRED:'Kedaluwarsa',REVOKED:'Dicabut'};

async function loadCodes(){
  const{data:{session}}=await supabaseClient.auth.getSession();
  if(!session?.user||!list)return;
  try{
    const data=await invoke({action:'LIST'});
    renderCodes(data?.codes??[]);
  }catch(error){
    list.replaceChildren(el('p',error.message||'Kode belum dapat dimuat.','form-message error'));
  }
}

function renderCodes(codes){
  list.replaceChildren();
  if(!codes.length){list.append(el('p','Belum ada Kode Akses Komunitas.','empty-state'));return;}
  for(const item of codes){
    const card=el('div',null,'pending-card');
    const info=el('div');
    const status=STATUS[item.status]??item.status;
    info.append(
      el('strong',item.label),
      el('p',status,`muted community-code-status status-${String(item.status).toLowerCase()}`),
      el('p',`Berlaku ${fmt(item.validFrom)} – ${fmt(item.validUntil)}`,'muted-small'),
      el('p',`Dibuat ${fmt(item.createdAt)} oleh ${item.createdBy||'Administrator Sistem'}`,'muted-small'),
    );
    const actions=el('div',null,'action-row');
    if(['ACTIVE','SCHEDULED'].includes(item.status)){
      const revoke=el('button','Nonaktifkan','danger-button');
      revoke.type='button';
      revoke.addEventListener('click',()=>revokeCode(item));
      actions.append(revoke);
    }
    card.append(info,actions);
    list.append(card);
  }
}

function openGeneratedCode(data){
  if(!codeText)return;
  codeText.textContent=data.code;
  if(codeMeta)codeMeta.textContent=`${data.label} · berlaku sampai ${fmt(data.validUntil)}`;
  if(dialog?.showModal)dialog.showModal();
  else alert(`Kode Akses Komunitas: ${data.code}\n\nSimpan sekarang. Kode ini tidak dapat ditampilkan ulang.`);
}

async function revokeCode(item){
  if(!confirm(`Nonaktifkan Kode Akses Komunitas “${item.label}”? Kode tidak dapat digunakan lagi setelah dinonaktifkan.`))return;
  try{
    show('Menonaktifkan Kode Akses Komunitas...');
    await invoke({action:'REVOKE',codeId:item.id});
    show('Kode Akses Komunitas berhasil dinonaktifkan.');
    await loadCodes();
  }catch(error){show(error.message,'error');}
}

form?.addEventListener('submit',async event=>{
  event.preventDefault();
  const label=document.querySelector('#communityCodeLabel')?.value.trim()??'';
  const fromDate=document.querySelector('#communityValidFrom')?.value??'';
  const untilDate=document.querySelector('#communityValidUntil')?.value??'';
  const validFrom=fromDate?new Date(`${fromDate}T00:00:00+07:00`).toISOString():null;
  const validUntil=untilDate?new Date(`${untilDate}T23:59:59+07:00`).toISOString():null;
  try{
    show('Membuat Kode Akses Komunitas...');
    const data=await invoke({action:'GENERATE',label,validFrom,validUntil});
    show('Kode Akses Komunitas berhasil dibuat. Salin kode dari popup dan simpan di tempat yang aman.');
    form.reset();
    openGeneratedCode(data);
    await loadCodes();
  }catch(error){show(error.message,'error');}
});

copyButton?.addEventListener('click',async()=>{
  const value=codeText?.textContent?.trim();
  if(!value)return;
  try{await navigator.clipboard.writeText(value);copyButton.textContent='Tersalin';setTimeout(()=>{copyButton.textContent='Salin kode';},1200);}catch(_){show('Browser tidak mengizinkan copy otomatis. Salin kode secara manual dari popup.','error');}
});

closeButton?.addEventListener('click',()=>dialog?.close());
dialog?.addEventListener('close',()=>{if(codeText)codeText.textContent='';if(codeMeta)codeMeta.textContent='';});
document.querySelector('#refreshButton')?.addEventListener('click',loadCodes);
supabaseClient.auth.onAuthStateChange((_event,session)=>{if(session?.user)loadCodes();});
await loadCodes();
