import { supabaseClient } from './supabase-client.js';

const loginPanel=document.querySelector('#loginPanel');
const dashboardPanel=document.querySelector('#dashboardPanel');
const loginMessage=document.querySelector('#loginMessage');
const pageMessage=document.querySelector('#pageMessage');
const userLabel=document.querySelector('#userLabel');
const caseList=document.querySelector('#caseList');
const caseDetail=document.querySelector('#caseDetail');
let rows=[]; let selectedId=null;

const STATUS={COMMITTEE_FORMATION:'Menunggu Pembentukan Tim',INVESTIGATION:'Pemeriksaan',AUTHORITY_REVIEW:'Review Otoritas',REMEDIATION:'Tindak Lanjut',CLOSED:'Selesai'};
function el(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
function fmt(v){return v?new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Jakarta'}).format(new Date(v)):'—';}
function show(text,kind='info'){pageMessage.textContent=text;pageMessage.className=`form-message internal-message ${kind}`;pageMessage.hidden=!text;}
async function invoke(body){const{data,error}=await supabaseClient.functions.invoke('dekom-case-action',{body});if(error){let msg=error.message;try{const c=await error.context?.json();if(c?.error)msg=c.error;}catch(_){}throw new Error(msg||'Aksi Dekom belum dapat diproses.');}return data;}
async function authorize(){const{data:{session}}=await supabaseClient.auth.getSession();if(!session?.user){loginPanel.hidden=false;dashboardPanel.hidden=true;return;}loginPanel.hidden=true;dashboardPanel.hidden=false;userLabel.textContent=session.user.email||'Akun Dekom';try{await load();}catch(e){show(e.message,'error');}}
async function load(){show('');const data=await invoke({action:'LIST'});rows=data.cases??[];renderList();if(selectedId&&rows.some(x=>x.id===selectedId))await selectCase(selectedId);else if(rows.length)await selectCase(rows[0].id);else caseDetail.replaceChildren(el('p','Tidak ada kasus yang berada dalam kewenangan Dekom.','empty-state'));}
function renderList(){caseList.replaceChildren();if(!rows.length){caseList.append(el('p','Tidak ada kasus Dekom.','empty-state'));return;}for(const r of rows){const b=el('button',null,`case-list-button${r.id===selectedId?' active':''}`);b.type='button';b.append(el('strong',r.public_case_id),el('span',STATUS[r.status]??r.status),el('span',r.acknowledged_at?'Sudah diterima':'Belum diterima'));b.addEventListener('click',()=>selectCase(r.id));caseList.append(b);}}
async function selectCase(id){selectedId=id;renderList();try{const d=await invoke({action:'DETAIL',caseId:id});renderDetail(d);}catch(e){show(e.message,'error');}}
function renderDetail(d){caseDetail.replaceChildren();const c=d.case,r=d.report,ack=d.acknowledgement,src=d.source;
 const head=el('section',null,'case-section');const sh=el('div',null,'status-head');sh.append(el('div',null),el('span',ack?'Sudah diterima Dekom':'Menunggu penerimaan Dekom','status-badge'));sh.firstChild.append(el('p','Kasus Dekom','eyebrow'),el('h2',r?.title||c.public_case_id));head.append(sh);
 const meta=el('div',null,'case-meta');[['Nomor Kasus',c.public_case_id],['Status',STATUS[c.status]??c.status],['Klasifikasi','Pelanggaran Integritas'],['Prioritas',c.priority||'—']].forEach(([k,v])=>{const x=el('div');x.append(el('span',k),el('strong',v));meta.append(x);});head.append(meta);caseDetail.append(head);
 const story=el('section',null,'case-section');story.append(el('h3','Uraian kasus'),el('p',r?.narrative||'—','case-copy'));caseDetail.append(story);
 if(src){const s=el('section',null,'case-section');s.append(el('h3','Konteks sumber'),el('p',`Linked dari ${src.public_case_id||'case sumber'} · Follow-up ${src.followup?.day_offset??'—'} hari`,'muted'));if(src.followup?.notes)s.append(el('h4','Temuan follow-up'),el('p',src.followup.notes,'case-copy'));if(src.followup?.escalation_note)s.append(el('h4','Catatan eskalasi'),el('p',src.followup.escalation_note,'case-copy'));s.append(el('p',`Status escalation sumber: ${src.followup?.escalation_status??'—'}`,'muted'));caseDetail.append(s);}
 const action=el('section',null,'case-section action-stack');action.append(el('h3','Pengambilalihan Dekom'));
 if(ack){action.append(el('div',null,'notice'));action.lastChild.append(el('strong','Pengambilalihan telah diterima'),el('p',ack.acknowledgement_note,'case-copy'),el('small',fmt(ack.acknowledged_at)));}
 else {const note=document.createElement('textarea');note.rows=4;note.placeholder='Catatan penerimaan pengambilalihan Dekom (wajib).';const btn=el('button','Terima Pengambilalihan','primary');btn.type='button';btn.addEventListener('click',async()=>{if(note.value.trim().length<5)return show('Catatan penerimaan wajib diisi.','error');if(!confirm(`Dekom menerima pengambilalihan ${c.public_case_id}?`))return;try{show('Mencatat penerimaan Dekom...');await invoke({action:'ACKNOWLEDGE',caseId:c.id,note:note.value});show('Pengambilalihan berhasil diterima Dekom.');await load();}catch(e){show(e.message,'error');}});action.append(note,btn);}
 caseDetail.append(action);
}
document.querySelector('#googleLogin')?.addEventListener('click',async()=>{const redirectTo=new URL('dekom.html',window.location.href).href;const{error}=await supabaseClient.auth.signInWithOAuth({provider:'google',options:{redirectTo}});if(error){loginMessage.textContent=error.message;loginMessage.className='form-message error';loginMessage.hidden=false;}});
document.querySelector('#refreshButton')?.addEventListener('click',load);
document.querySelector('#logoutButton')?.addEventListener('click',async()=>{await supabaseClient.auth.signOut();location.reload();});
await authorize();
