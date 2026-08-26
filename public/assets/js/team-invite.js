import { supabaseClient } from './supabase-client.js';

const loginPanel = document.querySelector('#loginPanel');
const invitePanel = document.querySelector('#invitePanel');
const loginMessage = document.querySelector('#loginMessage');
const pageMessage = document.querySelector('#pageMessage');
const userLabel = document.querySelector('#userLabel');
const nominationList = document.querySelector('#nominationList');

const ROLE = { CASE_LEAD: 'Ketua Tim', INVESTIGATOR: 'Pemeriksa', SUBJECT_MATTER_ADVISER: 'Subject Matter Adviser' };
const NOMINATION_STATUS = { PENDING_ACCOUNT: 'Menunggu akun', PENDING_DECLARATION: 'Menunggu deklarasi', CLEARED: 'Deklarasi selesai', CONFLICT: 'Benturan kepentingan dilaporkan', REVOKED: 'Penunjukan dicabut' };
const ACCESS_STATUS = { ACTIVE: 'Aktif — akses pemeriksaan diberikan', PENDING: 'Menunggu aktivasi oleh otoritas kasus', REVOKED: 'Akses dicabut' };
const AUTHORITY = { SECRETARIAT: 'Sekretariat DS', DEKOM: 'Dekom', HSE: 'Otoritas Perlindungan', GRIEVANCE: 'Koordinator Pengaduan', TRIAGE: 'Penelaah Awal' };

function el(tag,text,className){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;}
function show(text,kind='info'){pageMessage.textContent=text;pageMessage.className=`form-message ${kind}`;pageMessage.hidden=!text;}
async function invoke(body){const{data,error}=await supabaseClient.functions.invoke('team-member-declaration',{body});if(error){let detail=error.message;try{const c=await error.context?.json();if(c?.error)detail=c.error;}catch(_){}throw new Error(detail||'Permintaan belum dapat diproses.');}return data;}
function statusLabel(item){
  if(item.assignmentStatus==='ACTIVE') return 'Aktif — akses pemeriksaan diberikan';
  if(item.nominationStatus==='CLEARED' && item.assignmentStatus==='PENDING') return 'Deklarasi selesai — menunggu aktivasi tim';
  return NOMINATION_STATUS[item.nominationStatus]??item.nominationStatus;
}
function accessLabel(item){
  if(item.assignmentStatus) return ACCESS_STATUS[item.assignmentStatus]??item.assignmentStatus;
  if(item.nominationStatus==='CLEARED') return 'Belum aktif';
  if(item.nominationStatus==='CONFLICT') return 'Tidak diberikan';
  return 'Belum tersedia';
}

async function authorize(){const{data:{session}}=await supabaseClient.auth.getSession();if(!session?.user){loginPanel.hidden=false;invitePanel.hidden=true;return;}loginPanel.hidden=true;invitePanel.hidden=false;userLabel.textContent=session.user.email||'Akun Google';await load();}
async function load(){try{show('');const data=await invoke({action:'LIST'});render(data.nominations??[]);}catch(e){show(e.message,'error')}}
function render(items){nominationList.replaceChildren();if(!items.length){nominationList.append(el('div','Tidak ada penunjukan Tim Pemeriksa aktif untuk akun ini.','form-card'));return;}
 for(const item of items){const card=el('section',null,'form-card');const head=el('div',null,'status-head');head.append(el('h2',item.nomorLaporan||'Penunjukan Tim Pemeriksa'),el('span',statusLabel(item),'status-badge'));card.append(head);
 const summary=el('div',null,'summary-list');[['Peran',ROLE[item.committeeRole]??item.committeeRole],['Otoritas kasus',AUTHORITY[item.authorityCode]??item.authorityCode??'—'],['Kategori',item.memberCategory],['Klasifikasi',item.classification==='INTEGRITY'?'Pelanggaran Integritas':(item.classification??'—')],['Akses laporan',accessLabel(item)],['Alasan dipilih',item.rationale||'—'],['Konteks conflict check',item.conflictContext||'—']].forEach(([k,v])=>{const row=el('div');row.append(el('dt',k),el('dd',v));summary.append(row)});card.append(summary);
 if(item.assignmentStatus==='ACTIVE'){const link=document.createElement('a');link.className='button primary';link.href='investigation.html';link.textContent='Buka Workspace Pemeriksaan';card.append(link);}
 if(item.nominationStatus==='PENDING_DECLARATION'){const statement=el('div',null,'notice');statement.textContent='Saya menyatakan tidak mempunyai kepentingan pribadi, hubungan, kewajiban, atau kondisi lain yang dapat mempengaruhi independensi saya dalam menangani laporan ini.';card.append(statement);
 const field=document.createElement('fieldset');const legend=el('legend','Pilih hasil deklarasi');field.append(legend);
 const a=document.createElement('label');a.className='choice';a.innerHTML='<input type="radio" name="decl-'+item.id+'" value="NO_CONFLICT"> Saya tidak memiliki benturan kepentingan';
 const b=document.createElement('label');b.className='choice';b.innerHTML='<input type="radio" name="decl-'+item.id+'" value="POSSIBLE_CONFLICT"> Saya memiliki kemungkinan benturan kepentingan';field.append(a,b);card.append(field);
 const notes=document.createElement('textarea');notes.rows=3;notes.placeholder='Catatan tambahan (opsional, atau jelaskan potensi benturan jika ada).';card.append(notes);
 const btn=el('button','Kirim deklarasi','primary');btn.type='button';btn.addEventListener('click',async()=>{const selected=card.querySelector('input[type=radio]:checked');if(!selected)return show('Pilih hasil deklarasi terlebih dahulu.','error');try{show('Menyimpan deklarasi...');const data=await invoke({action:'DECLARE',memberId:item.id,declaration:selected.value,notes:notes.value});show(data.nominationStatus==='CLEARED'?'Deklarasi tersimpan. Akses belum aktif sampai otoritas kasus mengaktifkan Tim Pemeriksa.':'Potensi benturan kepentingan tercatat. Akses case tidak diberikan.');await load();}catch(e){show(e.message,'error')}});card.append(btn);
 }
 nominationList.append(card);}
}

document.querySelector('#googleLogin')?.addEventListener('click',async()=>{const redirectTo=new URL('team-invite.html',window.location.href).href;const{error}=await supabaseClient.auth.signInWithOAuth({provider:'google',options:{redirectTo}});if(error){loginMessage.textContent=error.message;loginMessage.hidden=false;}});
document.querySelector('#logoutButton')?.addEventListener('click',async()=>{await supabaseClient.auth.signOut();location.reload();});
await authorize();
