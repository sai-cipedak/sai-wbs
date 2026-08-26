import { supabaseClient } from './supabase-client.js';

const loginPanel=document.querySelector('#loginPanel');
const workspacePanel=document.querySelector('#workspacePanel');
const loginMessage=document.querySelector('#loginMessage');
const userLabel=document.querySelector('#userLabel');
const pageMessage=document.querySelector('#pageMessage');
const reportList=document.querySelector('#reportList');
function el(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
function fmt(v){return v?new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Jakarta'}).format(new Date(v)):'—';}
function show(text,kind='info'){pageMessage.textContent=text;pageMessage.className=`form-message internal-message ${kind}`;pageMessage.hidden=!text;}
async function load(){show('');const{data,error}=await supabaseClient.functions.invoke('my-identified-reports',{body:{}});if(error){let msg=error.message;try{const c=await error.context?.json();if(c?.error)msg=c.error;}catch(_){}throw new Error(msg||'Laporan belum dapat dimuat.');}render(data?.laporan??[]);}
function render(rows){reportList.replaceChildren();if(!rows.length){const empty=el('section',null,'form-card');empty.append(el('h2','Belum ada laporan'),el('p','Laporan beridentitas yang Anda kirim akan muncul di sini.','muted'));const a=el('a','Sampaikan laporan','button primary');a.href='lapor-identitas.html';empty.append(a);reportList.append(empty);return;}
 for(const item of rows){const card=el('section',null,'form-card');const head=el('div',null,'status-head');const title=el('div');title.append(el('p',item.nomorLaporan,'eyebrow'),el('h2',item.judul),el('p',`Diterima ${fmt(item.tanggalLaporan)}`,'muted'));head.append(title,el('span',item.status,'status-badge'));card.append(head);
  const meta=el('div',null,'case-meta');[['Klasifikasi',item.klasifikasi||'Belum ditentukan'],['Status',item.status],['Nomor laporan',item.nomorLaporan],['Ditutup',item.closedAt?fmt(item.closedAt):'—']].forEach(([k,v])=>{const x=el('div');x.append(el('span',k),el('strong',v));meta.append(x);});card.append(meta);
  if(item.isTestData){const note=el('div',null,'notice');note.append(el('strong','Data UAT / Test'),el('p',item.testLabel||'Case ini ditandai sebagai data pengujian.'));card.append(note);}
  if(item.hasilAkhir){const final=el('div',null,'action-card');final.append(el('h3','Hasil Akhir'));for(const o of item.hasilAkhir.outcomes??[]){final.append(el('p',`Dugaan ${o.sequenceNo}: ${o.label}`,'case-copy'));}if(item.hasilAkhir.ringkasan)final.append(el('h4','Ringkasan'),el('p',item.hasilAkhir.ringkasan,'case-copy'));card.append(final);}
  const comm=el('div',null,'action-card');comm.append(el('h3','Komunikasi dengan Tim Penanganan'));if(!(item.pesan??[]).length)comm.append(el('p','Belum ada pesan.','muted'));for(const m of item.pesan??[]){const row=el('div',null,'message-item');row.append(el('strong',m.dari),el('p',m.isi),el('small',fmt(m.waktu)));comm.append(row);}
  if(item.canMessage){const ta=document.createElement('textarea');ta.rows=3;ta.placeholder='Tulis informasi tambahan atau balasan untuk Tim Penanganan.';const btn=el('button','Kirim pesan','secondary');btn.type='button';btn.addEventListener('click',async()=>{const text=ta.value.trim();if(text.length<5)return show('Pesan minimal 5 karakter.','error');try{show('Mengirim pesan...');const{error}=await supabaseClient.functions.invoke('send-identified-message',{body:{caseId:item.id,message:text}});if(error){let msg=error.message;try{const c=await error.context?.json();if(c?.error)msg=c.error;}catch(_){}throw new Error(msg);}show('Pesan berhasil dikirim.');await load();}catch(e){show(e.message||'Pesan belum dapat dikirim.','error');}});comm.append(ta,btn);}else comm.append(el('p','Laporan ini sudah ditutup. Kanal pesan baru tidak lagi dibuka.','muted'));
  card.append(comm);reportList.append(card);
 }}
async function authorize(){const{data:{session}}=await supabaseClient.auth.getSession();if(!session?.user){loginPanel.hidden=false;workspacePanel.hidden=true;return;}loginPanel.hidden=true;workspacePanel.hidden=false;userLabel.textContent=session.user.email||'Akun Google';try{await load();}catch(e){show(e.message,'error');}}
document.querySelector('#googleLogin')?.addEventListener('click',async()=>{const redirectTo=new URL('my-reports.html',window.location.href).href;const{error}=await supabaseClient.auth.signInWithOAuth({provider:'google',options:{redirectTo}});if(error){loginMessage.textContent=error.message;loginMessage.className='form-message error';loginMessage.hidden=false;}});
document.querySelector('#refreshButton')?.addEventListener('click',load);
document.querySelector('#logoutButton')?.addEventListener('click',async()=>{await supabaseClient.auth.signOut();location.reload();});
await authorize();
