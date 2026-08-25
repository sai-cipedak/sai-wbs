import { supabaseClient } from './supabase-client.js';

const loginPanel=document.querySelector('#loginPanel');
const dashboardPanel=document.querySelector('#dashboardPanel');
const loginMessage=document.querySelector('#loginMessage');
const userLabel=document.querySelector('#userLabel');
const caseList=document.querySelector('#caseList');
const caseDetail=document.querySelector('#caseDetail');
const pageMessage=document.querySelector('#pageMessage');
let cases=[];let selectedCaseId=null;

const STATUS_LABELS={COMMITTEE_FORMATION:'Menunggu Pembentukan Tim',INVESTIGATION:'Pemeriksaan Sedang Berlangsung',AUTHORITY_REVIEW:'Hasil Sedang Ditinjau',REMEDIATION:'Tindak Lanjut Sedang Dilakukan'};
const TEAM_STATUS={PENDING_ACCOUNT:'Menunggu kandidat masuk',PENDING_DECLARATION:'Menunggu deklarasi',CLEARED:'Lolos conflict check',CONFLICT:'Ada kemungkinan benturan kepentingan',REVOKED:'Dicabut'};
const ACCESS_STATUS={ACTIVE:'Aktif',PENDING:'Menunggu aktivasi',REVOKED:'Dicabut'};
const TEAM_ROLE={CASE_LEAD:'Ketua Tim',INVESTIGATOR:'Pemeriksa',SUBJECT_MATTER_ADVISER:'Subject Matter Adviser'};
const CATEGORY={DS:'DS',MANAGEMENT:'Management',STAFF:'Staff',OTS:'OTS',EXTERNAL:'Pihak Eksternal'};
const FINDING_LABEL={PROVEN:'Terbukti',PARTIALLY_PROVEN:'Sebagian Terbukti',NOT_PROVEN:'Tidak Terbukti',INCONCLUSIVE:'Tidak Dapat Disimpulkan',NOT_EXAMINABLE:'Tidak Dapat Diperiksa',OUT_OF_SCOPE:'Di Luar Ruang Lingkup'};
const REVIEW_LABEL={APPROVED:'Disetujui',RETURNED_FOR_REVISION:'Dikembalikan untuk Revisi'};
const REMEDIATION_LABEL={PENDING:'Belum Selesai',IN_PROGRESS:'Sedang Dikerjakan',COMPLETED:'Selesai',WAIVED:'Di-waive'};

function el(tag,text,className){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;}
function fmtDate(v){return v?new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short'}).format(new Date(v)):'—';}
function showMessage(text,kind='info'){pageMessage.textContent=text;pageMessage.className=`form-message internal-message ${kind}`;pageMessage.hidden=!text;}
async function invoke(body){const{data,error}=await supabaseClient.functions.invoke('secretariat-team-action',{body});if(error){let detail=error.message;try{const c=await error.context?.json();if(c?.error)detail=c.error;}catch(_){}throw new Error(detail||'Aksi belum dapat diproses.');}return data;}

async function authorize(){const{data:{session}}=await supabaseClient.auth.getSession();if(!session?.user){loginPanel.hidden=false;dashboardPanel.hidden=true;return;}userLabel.textContent=session.user.email||'Akun Sekretariat';try{loginPanel.hidden=true;dashboardPanel.hidden=false;await loadCases();}catch(error){loginPanel.hidden=false;dashboardPanel.hidden=true;loginMessage.textContent=error instanceof Error?error.message:'Akun belum memiliki kewenangan Sekretariat DS.';loginMessage.className='form-message error';loginMessage.hidden=false;}}
async function loadCases(){showMessage('');const data=await invoke({action:'LIST'});cases=data.cases??[];renderCaseList();if(selectedCaseId&&cases.some(c=>c.id===selectedCaseId))await loadDetail(selectedCaseId);else if(cases.length)await loadDetail(cases[0].id);else caseDetail.replaceChildren(el('p','Tidak ada kasus aktif di bawah kewenangan Sekretariat DS.','empty-state'));}
function renderCaseList(){caseList.replaceChildren();if(!cases.length)return caseList.append(el('p','Tidak ada kasus aktif.','empty-state'));for(const c of cases){const b=el('button',null,`case-list-button${c.id===selectedCaseId?' active':''}`);b.type='button';b.append(el('strong',c.public_case_id),el('span',c.title),el('span',STATUS_LABELS[c.status]??c.status));b.addEventListener('click',()=>loadDetail(c.id));caseList.append(b);}}
async function loadDetail(caseId){selectedCaseId=caseId;renderCaseList();showMessage('');const data=await invoke({action:'DETAIL',caseId});renderDetail(data);}

function renderDetail(data){
 const c=data.case,report=data.report,messages=data.messages??[],team=data.team??[],allegations=data.allegations??[],findings=data.findings??[],reviews=data.reviews??[],remediation=data.remediation??[];
 caseDetail.replaceChildren();
 const head=el('section',null,'case-section');const h=el('div',null,'status-head');h.append(el('h2',report?.title??c.public_case_id),el('span',STATUS_LABELS[c.status]??c.status,'status-badge'));head.append(h);
 const meta=el('div',null,'case-meta');[['Nomor Laporan',c.public_case_id],['Pelapor',c.reporting_mode==='ANONYMOUS'?'Tanpa Identitas':'Identitas Dirahasiakan'],['Klasifikasi','Pelanggaran Integritas'],['Diterima',fmtDate(c.submitted_at)]].forEach(([k,v])=>{const x=el('div');x.append(el('span',k),el('strong',v));meta.append(x);});head.append(meta);caseDetail.append(head);

 const story=el('section',null,'case-section');story.append(el('h3','Ringkasan laporan'),el('p',report?.narrative??'—','case-copy'));caseDetail.append(story);

 const comm=el('section',null,'case-section');comm.append(el('h3','Komunikasi dengan pelapor'));if(!messages.length)comm.append(el('p','Belum ada pesan.','muted'));messages.forEach(m=>{const box=el('div',null,'message-item');box.append(el('strong',m.sender_type==='REPORTER'?'Pelapor':m.sender_type==='SYSTEM'?'Sistem':'Tim Penanganan'),el('p',m.body),el('small',fmtDate(m.created_at)));comm.append(box);});caseDetail.append(comm);

 if(allegations.length){
  const results=el('section',null,'case-section');results.append(el('h3','Hasil Pemeriksaan'));
  const findingMap=new Map(findings.map(f=>[f.allegation_id,f]));
  allegations.forEach(a=>{const f=findingMap.get(a.id);const card=el('div',null,'action-card');const top=el('div',null,'status-head');top.append(el('strong',`Dugaan ${a.sequence_no}`),el('span',f?(FINDING_LABEL[f.finding_status]??f.finding_status):'Belum ada hasil','status-badge'));card.append(top,el('p',a.statement,'case-copy'));if(f){card.append(el('h4','Analisis'),el('p',f.analysis_text,'case-copy'),el('h4','Rekomendasi'),el('p',f.recommendation_text||'Tidak ada rekomendasi.','case-copy'));}results.append(card);});
  if(reviews.length){const history=el('div',null,'action-card');history.append(el('h3','Riwayat Review Sekretariat'));reviews.forEach(r=>{const row=el('div',null,'message-item');row.append(el('strong',REVIEW_LABEL[r.decision]??r.decision),el('p',r.review_notes),el('small',fmtDate(r.created_at)));history.append(row);});results.append(history);}
  if(c.status==='AUTHORITY_REVIEW'){
   const review=el('div',null,'action-card');review.append(el('h3','Keputusan Sekretariat'),el('p','Sekretariat tidak mengubah finding Tim Pemeriksa secara langsung. Setujui hasil atau kembalikan dengan catatan revisi.','muted'));
   const notes=document.createElement('textarea');notes.rows=4;notes.placeholder='Catatan review Sekretariat (wajib).';review.append(notes);
   const row=el('div',null,'action-row');const back=el('button','Kembalikan untuk Revisi','secondary');back.type='button';back.addEventListener('click',()=>reviewFindings(c.id,'RETURNED_FOR_REVISION',notes.value));const approve=el('button','Setujui Hasil','primary');approve.type='button';approve.addEventListener('click',()=>reviewFindings(c.id,'APPROVED',notes.value));row.append(back,approve);review.append(row);results.append(review);
  }
  caseDetail.append(results);
 }

 if(c.status==='REMEDIATION') caseDetail.append(renderRemediation(c,remediation));

 const teamSection=el('section',null,'case-section');const activeCount=team.filter(m=>m.assignment_status==='ACTIVE'&&['CASE_LEAD','INVESTIGATOR'].includes(m.committee_role)).length;const teamHead=el('div',null,'status-head');teamHead.append(el('h3','Tim Pemeriksa'),el('span',`${activeCount} active`,'status-badge'));teamSection.append(teamHead);
 if(!team.length)teamSection.append(el('p','Belum ada kandidat Tim Pemeriksa.','muted'));
 for(const m of team){const card=el('div',null,'team-member-card');const top=el('div',null,'status-head');top.append(el('strong',m.display_name||m.email),el('span',TEAM_STATUS[m.nomination_status]??m.nomination_status,'status-badge'));card.append(top);card.append(el('p',`${TEAM_ROLE[m.committee_role]??m.committee_role} · ${CATEGORY[m.member_category]??m.member_category}`,'muted'),el('p',m.email));const access=ACCESS_STATUS[m.assignment_status]??(m.nomination_status==='CLEARED'?'Belum aktif':'Belum tersedia');card.append(el('p',`Akses case: ${access}`,m.assignment_status==='ACTIVE'?'assignment-active':'muted'));if(c.status==='COMMITTEE_FORMATION'&&m.nomination_status!=='REVOKED'){const revoke=el('button','Cabut penunjukan','text-button');revoke.type='button';revoke.addEventListener('click',()=>revokeMember(c.id,m.id));card.append(revoke);}teamSection.append(card);}
 if(c.status==='COMMITTEE_FORMATION'){
  const form=el('div',null,'action-card');form.append(el('h3','Tambah kandidat'));const name=input('Nama kandidat','text','Nama lengkap (opsional)');const email=input('Email Google kandidat','email','nama@gmail.com');const category=select('Kategori anggota',[['DS','DS'],['MANAGEMENT','Management'],['STAFF','Staff'],['OTS','OTS'],['EXTERNAL','Pihak Eksternal']]);const role=select('Peran dalam tim',[['CASE_LEAD','Ketua Tim'],['INVESTIGATOR','Pemeriksa'],['SUBJECT_MATTER_ADVISER','Subject Matter Adviser']]);const rationale=textarea('Kompetensi / alasan pemilihan','Contoh: memahami proses terkait dan independen dari pihak terlapor.');const context=textarea('Konteks untuk conflict check','Masukkan hanya konteks minimum yang dibutuhkan kandidat untuk menilai benturan kepentingan.');form.append(name.wrap,email.wrap,category.wrap,role.wrap,rationale.wrap,context.wrap);const add=el('button','Tambahkan kandidat','secondary');add.type='button';add.addEventListener('click',()=>addMember(c.id,{displayName:name.field.value,email:email.field.value,memberCategory:category.field.value,committeeRole:role.field.value,rationale:rationale.field.value,conflictContext:context.field.value}));form.append(add);teamSection.append(form);
  const activate=el('div',null,'action-card');activate.append(el('h3','Aktifkan Tim Pemeriksa'),el('p','Sistem hanya akan mengaktifkan tim jika minimal 2 orang berbeda sudah lolos deklarasi benturan kepentingan.','muted'));const btn=el('button','Aktifkan Tim Pemeriksa','primary');btn.type='button';btn.addEventListener('click',()=>activateTeam(c.id));activate.append(btn);teamSection.append(activate);
 }
 caseDetail.append(teamSection);
}

function renderRemediation(c,items){
 const section=el('section',null,'case-section');const done=items.filter(x=>['COMPLETED','WAIVED'].includes(x.status)).length;const head=el('div',null,'status-head');head.append(el('h3','Tindak Lanjut'),el('span',`${done}/${items.length} selesai`,'status-badge'));section.append(head,el('p','Seluruh action item harus selesai atau di-waive sebelum kasus dapat ditutup.','muted'));
 if(!items.length)section.append(el('p','Belum ada action item tindak lanjut. Jika memang tidak diperlukan tindakan tambahan, case tetap dapat ditutup dengan justifikasi yang memadai pada Ringkasan Internal.','empty-state'));
 items.forEach(item=>{const card=el('div',null,'action-card');const top=el('div',null,'status-head');top.append(el('strong',item.action_text),el('span',REMEDIATION_LABEL[item.status]??item.status,'status-badge'));card.append(top);const meta=[item.owner_text?`PIC: ${item.owner_text}`:null,item.due_date?`Target: ${item.due_date}`:null].filter(Boolean);if(meta.length)card.append(el('p',meta.join(' · '),'muted'));if(item.completion_note)card.append(el('p',`Catatan: ${item.completion_note}`,'case-copy'));
  if(!['COMPLETED','WAIVED'].includes(item.status)){const note=document.createElement('textarea');note.rows=3;note.placeholder='Catatan penyelesaian atau alasan waiver.';card.append(note);const row=el('div',null,'action-row');const waive=el('button','Waive','secondary');waive.type='button';waive.addEventListener('click',()=>completeRemediation(c.id,item.id,note.value,true));const complete=el('button','Tandai Selesai','primary');complete.type='button';complete.addEventListener('click',()=>completeRemediation(c.id,item.id,note.value,false));row.append(waive,complete);card.append(row);}section.append(card);});

 const add=el('div',null,'action-card');add.append(el('h3','Tambah tindak lanjut'));const action=textarea('Tindak lanjut','Contoh: memperbarui SOP dan menyampaikan perubahan kepada pihak terkait.');const owner=input('PIC / pemilik tindak lanjut','text','Nama atau unit (opsional)');const due=input('Target selesai','date','');add.append(action.wrap,owner.wrap,due.wrap);const addBtn=el('button','Tambah action item','secondary');addBtn.type='button';addBtn.addEventListener('click',()=>addRemediation(c.id,action.field.value,owner.field.value,due.field.value));add.append(addBtn);section.append(add);

 const close=el('div',null,'action-card');close.append(el('h3','Tutup Kasus'),el('p','Hasil per dugaan akan ditampilkan kepada pelapor tanpa analisis internal. Ringkasan untuk pelapor harus aman, jelas, dan tidak mengungkap informasi sensitif yang tidak perlu.','muted'));const internal=textarea('Ringkasan internal penutupan','Jelaskan dasar penutupan, tindak lanjut yang dilakukan, dan catatan governance.');const reporter=textarea('Ringkasan untuk pelapor','Contoh: Pemeriksaan telah selesai dan tindak lanjut yang diperlukan telah dilakukan.');close.append(internal.wrap,reporter.wrap);const closeBtn=el('button','Tutup Kasus','primary');closeBtn.type='button';closeBtn.addEventListener('click',()=>closeCase(c.id,internal.field.value,reporter.field.value));close.append(closeBtn);section.append(close);
 return section;
}

function input(label,type,placeholder){const wrap=document.createElement('label');wrap.textContent=label;const field=document.createElement('input');field.type=type;if(placeholder)field.placeholder=placeholder;wrap.append(field);return{wrap,field};}
function textarea(label,placeholder){const wrap=document.createElement('label');wrap.textContent=label;const field=document.createElement('textarea');field.rows=3;field.placeholder=placeholder;wrap.append(field);return{wrap,field};}
function select(label,opts){const wrap=document.createElement('label');wrap.textContent=label;const field=document.createElement('select');opts.forEach(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;field.append(o);});wrap.append(field);return{wrap,field};}
async function addMember(caseId,payload){try{showMessage('Menambahkan kandidat...');await invoke({action:'ADD_MEMBER',caseId,...payload});showMessage('Kandidat berhasil ditambahkan.');await loadDetail(caseId);}catch(e){showMessage(e.message,'error');}}
async function revokeMember(caseId,memberId){if(!confirm('Cabut penunjukan kandidat ini?'))return;try{await invoke({action:'REVOKE_MEMBER',caseId,memberId});showMessage('Penunjukan dicabut.');await loadDetail(caseId);}catch(e){showMessage(e.message,'error');}}
async function activateTeam(caseId){try{showMessage('Memeriksa kelengkapan tim...');const data=await invoke({action:'ACTIVATE_TEAM',caseId});showMessage(`Tim aktif dengan ${data.investigatorCount} pemeriksa.`);await loadCases();}catch(e){showMessage(e.message,'error');}}
async function reviewFindings(caseId,decision,reviewNotes){if(reviewNotes.trim().length<5)return showMessage('Catatan review wajib diisi minimal 5 karakter.','error');if(decision==='APPROVED'&&!confirm('Setujui hasil pemeriksaan dan lanjutkan ke tahap tindak lanjut?'))return;try{showMessage('Menyimpan keputusan review...');const data=await invoke({action:'REVIEW_FINDINGS',caseId,decision,reviewNotes});showMessage(data.status==='REMEDIATION'?'Hasil pemeriksaan disetujui. Case masuk tahap Tindak Lanjut.':'Hasil dikembalikan ke Tim Pemeriksa untuk revisi.');await loadCases();}catch(e){showMessage(e.message,'error');}}
async function addRemediation(caseId,actionText,ownerText,dueDate){try{showMessage('Menambahkan tindak lanjut...');await invoke({action:'ADD_REMEDIATION_ACTION',caseId,actionText,ownerText,dueDate});showMessage('Action item ditambahkan.');await loadDetail(caseId);}catch(e){showMessage(e.message,'error');}}
async function completeRemediation(caseId,remediationId,completionNote,waive){if(completionNote.trim().length<5)return showMessage('Catatan penyelesaian/alasan waiver wajib minimal 5 karakter.','error');try{await invoke({action:waive?'WAIVE_REMEDIATION_ACTION':'COMPLETE_REMEDIATION_ACTION',caseId,remediationId,completionNote});showMessage(waive?'Action item di-waive.':'Action item selesai.');await loadDetail(caseId);}catch(e){showMessage(e.message,'error');}}
async function closeCase(caseId,internalSummary,reporterSummary){if(internalSummary.trim().length<5||reporterSummary.trim().length<5)return showMessage('Kedua ringkasan penutupan wajib diisi.','error');if(!confirm('Tutup kasus? Status akan menjadi Selesai Ditangani dan akses Tim Pemeriksa dicabut.'))return;try{showMessage('Menutup kasus...');await invoke({action:'CLOSE_CASE',caseId,internalSummary,reporterSummary});showMessage('Kasus berhasil ditutup.');selectedCaseId=null;await loadCases();}catch(e){showMessage(e.message,'error');}}

document.querySelector('#googleLogin')?.addEventListener('click',async()=>{const redirectTo=new URL('secretariat.html',window.location.href).href;const{error}=await supabaseClient.auth.signInWithOAuth({provider:'google',options:{redirectTo}});if(error){loginMessage.textContent=error.message;loginMessage.hidden=false;}});
document.querySelector('#logoutButton')?.addEventListener('click',async()=>{await supabaseClient.auth.signOut();location.reload();});
document.querySelector('#refreshButton')?.addEventListener('click',loadCases);
await authorize();
