import { supabaseClient } from './supabase-client.js';

const loginPanel = document.querySelector('#loginPanel');
const workspacePanel = document.querySelector('#workspacePanel');
const loginMessage = document.querySelector('#loginMessage');
const pageMessage = document.querySelector('#pageMessage');
const userLabel = document.querySelector('#userLabel');
const caseList = document.querySelector('#caseList');
const caseDetail = document.querySelector('#caseDetail');
const UAT = new URLSearchParams(location.search).get('uat') === '1';
let cases = [];
let selectedCaseId = null;

const STATUS = { INVESTIGATION: 'Pemeriksaan Sedang Berlangsung', AUTHORITY_REVIEW: 'Hasil Sedang Ditinjau' };
const ROLE = { CASE_LEAD: 'Ketua Tim', INVESTIGATOR: 'Pemeriksa', SUBJECT_MATTER_ADVISER: 'Subject Matter Adviser' };
const NOTE = { GENERAL: 'Catatan Umum', INTERVIEW: 'Wawancara', EVIDENCE: 'Catatan Bukti', ANALYSIS: 'Analisis' };
const FINDING = {
  PROVEN: 'Terbukti', PARTIALLY_PROVEN: 'Sebagian Terbukti', NOT_PROVEN: 'Tidak Terbukti',
  INCONCLUSIVE: 'Tidak Dapat Disimpulkan', NOT_EXAMINABLE: 'Tidak Dapat Diperiksa', OUT_OF_SCOPE: 'Di Luar Ruang Lingkup',
};

function el(tag, text, className) { const n = document.createElement(tag); if (text != null) n.textContent = text; if (className) n.className = className; return n; }
function fmt(v) { return v ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(v)) : '—'; }
function show(text, kind = 'info') { pageMessage.textContent = text; pageMessage.className = `form-message internal-message ${kind}`; pageMessage.hidden = !text; }
async function invoke(body) {
  const { data, error } = await supabaseClient.functions.invoke('investigation-case-action', { body: { ...body, includeTestData: UAT } });
  if (error) {
    let detail = error.message;
    try { const c = await error.context?.json(); if (c?.error) detail = c.error; } catch (_) {}
    throw new Error(detail || 'Permintaan belum dapat diproses.');
  }
  return data;
}

async function authorize() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session?.user) { loginPanel.hidden = false; workspacePanel.hidden = true; return; }
  loginPanel.hidden = true; workspacePanel.hidden = false; userLabel.textContent = session.user.email || 'Akun Tim Pemeriksa';
  document.querySelector('#uatNotice').hidden = !UAT;
  try { await loadCases(); } catch (e) { show(e.message, 'error'); }
}

async function loadCases() {
  show('');
  const data = await invoke({ action: 'LIST' });
  cases = data.cases ?? [];
  renderCaseList();
  if (selectedCaseId && cases.some((c) => c.id === selectedCaseId)) await loadDetail(selectedCaseId);
  else if (cases.length) await loadDetail(cases[0].id);
  else caseDetail.replaceChildren(el('p', 'Tidak ada assignment pemeriksaan aktif untuk akun ini.', 'empty-state'));
}

function renderCaseList() {
  caseList.replaceChildren();
  if (!cases.length) return caseList.append(el('p', 'Tidak ada assignment aktif.', 'empty-state'));
  for (const c of cases) {
    const b = el('button', null, `case-list-button${c.id === selectedCaseId ? ' active' : ''}`); b.type = 'button'; b.dataset.caseId = c.id;
    b.append(el('strong', c.public_case_id), el('span', c.title), el('span', `${ROLE[c.assignmentRole] ?? c.assignmentRole} · ${STATUS[c.status] ?? c.status}`));
    b.addEventListener('click', () => loadDetail(c.id)); caseList.append(b);
  }
}

async function loadDetail(caseId) {
  selectedCaseId = caseId; renderCaseList(); show('');
  try { const data = await invoke({ action: 'DETAIL', caseId }); renderDetail(data); }
  catch (e) { show(e.message, 'error'); }
}

function renderDetail(data) {
  const c = data.case; const role = data.assignmentRole; const report = data.report;
  caseDetail.replaceChildren();
  const head = el('section', null, 'case-section');
  const top = el('div', null, 'status-head'); top.append(el('h2', report?.title ?? c.public_case_id), el('span', STATUS[c.status] ?? c.status, 'status-badge')); head.append(top);
  const meta = el('div', null, 'case-meta');
  [['Nomor Laporan', c.public_case_id], ['Peran Anda', ROLE[role] ?? role], ['Pelapor', c.reporting_mode === 'ANONYMOUS' ? 'Tanpa Identitas' : 'Identitas Dirahasiakan'], ['Klasifikasi', 'Pelanggaran Integritas'], ['Diterima', fmt(c.submitted_at)]].forEach(([k,v]) => { const x = el('div'); x.append(el('span', k), el('strong', v)); meta.append(x); });
  head.append(meta); caseDetail.append(head);

  if (c.status === 'AUTHORITY_REVIEW') caseDetail.append(el('div', 'Hasil sudah dikirim ke Sekretariat. Workspace pemeriksaan saat ini hanya-baca sampai ada keputusan atau permintaan pemeriksaan tambahan.', 'notice'));

  const tabs = el('div', null, 'workspace-tabs');
  const panels = el('div', null, 'workspace-panels');
  const definitions = [
    ['summary', 'Ringkasan', renderSummary(data)],
    ['findings', 'Dugaan & Hasil', renderFindings(data)],
    ['notes', 'Catatan Pemeriksaan', renderNotes(data)],
    ['messages', 'Komunikasi Pelapor', renderMessages(data)],
    ['evidence', 'Bukti', renderEvidence(data)],
  ];
  definitions.forEach(([id,label,panel], index) => {
    const b = el('button', label, `workspace-tab${index === 0 ? ' active' : ''}`); b.type = 'button'; b.dataset.tab = id;
    panel.dataset.panel = id; panel.hidden = index !== 0;
    b.addEventListener('click', () => {
      tabs.querySelectorAll('.workspace-tab').forEach((x) => x.classList.remove('active')); b.classList.add('active');
      panels.querySelectorAll('[data-panel]').forEach((x) => x.hidden = x.dataset.panel !== id);
    });
    tabs.append(b); panels.append(panel);
  });
  caseDetail.append(tabs, panels);
}

function renderSummary(data) {
  const report = data.report; const p = el('section', null, 'case-section workspace-panel');
  p.append(el('h3', 'Uraian laporan'), el('p', report?.narrative ?? '—', 'case-copy'));
  if (report?.people_involved_text) p.append(el('h3', 'Pihak terkait'), el('p', report.people_involved_text, 'case-copy'));
  const bits = [report?.incident_date ? `Tanggal: ${report.incident_date}` : null, report?.incident_time_text ? `Waktu: ${report.incident_time_text}` : null, report?.location_text ? `Lokasi: ${report.location_text}` : null].filter(Boolean);
  if (bits.length) p.append(el('p', bits.join(' · '), 'muted'));
  if (report?.child_safety_risk || report?.ongoing_risk) p.append(el('div', 'PERHATIAN: laporan memiliki indikator keselamatan/perlindungan. Jangan menunda tindakan protektif yang diperlukan.', 'form-message error'));
  return p;
}

function renderFindings(data) {
  const p = el('section', null, 'case-section workspace-panel'); const role = data.assignmentRole; const editable = data.case.status === 'INVESTIGATION';
  p.append(el('h3', 'Dugaan dan hasil pemeriksaan'), el('p', 'Setiap dugaan harus memiliki hasil dan analisis tersendiri sebelum Ketua Tim dapat mengirim hasil ke Sekretariat.', 'muted'));
  if (editable && role === 'CASE_LEAD') {
    const add = el('div', null, 'action-card'); add.append(el('h3', 'Tambah dugaan pemeriksaan'));
    const t = document.createElement('textarea'); t.rows = 3; t.placeholder = 'Rumuskan satu dugaan secara spesifik dan netral.'; add.append(t);
    const b = el('button', 'Tambah dugaan', 'secondary'); b.type = 'button'; b.addEventListener('click', async () => { try { show('Menyimpan dugaan...'); await invoke({ action:'SAVE_ALLEGATION', caseId:data.case.id, statement:t.value }); show('Dugaan berhasil ditambahkan.'); await loadDetail(data.case.id); } catch(e) { show(e.message,'error'); } }); add.append(b); p.append(add);
  }
  const findingMap = new Map((data.findings ?? []).map((f) => [f.allegation_id, f]));
  if (!(data.allegations ?? []).length) p.append(el('p', 'Belum ada dugaan pemeriksaan yang ditetapkan.', 'empty-state'));
  for (const allegation of (data.allegations ?? []).filter((a) => a.status === 'ACTIVE')) {
    const card = el('div', null, 'finding-card'); const finding = findingMap.get(allegation.id);
    card.append(el('p', `Dugaan ${allegation.sequence_no}`, 'eyebrow'));
    if (editable && role === 'CASE_LEAD') {
      const st = document.createElement('textarea'); st.rows = 3; st.value = allegation.statement; card.append(st);
      const saveStatement = el('button', 'Simpan rumusan dugaan', 'text-button'); saveStatement.type = 'button'; saveStatement.addEventListener('click', async () => { try { await invoke({ action:'SAVE_ALLEGATION', caseId:data.case.id, allegationId:allegation.id, statement:st.value }); show('Rumusan dugaan diperbarui.'); await loadDetail(data.case.id); } catch(e) { show(e.message,'error'); } }); card.append(saveStatement);
    } else card.append(el('p', allegation.statement, 'case-copy'));

    if (editable && ['CASE_LEAD','INVESTIGATOR'].includes(role)) {
      const status = document.createElement('select'); Object.entries(FINDING).forEach(([v,t]) => { const o=document.createElement('option'); o.value=v; o.textContent=t; if(finding?.finding_status===v)o.selected=true; status.append(o); });
      const analysis = document.createElement('textarea'); analysis.rows = 5; analysis.placeholder = 'Analisis fakta, bukti, dan pertimbangan yang mendasari hasil.'; analysis.value = finding?.analysis_text ?? '';
      const rec = document.createElement('textarea'); rec.rows = 3; rec.placeholder = 'Rekomendasi tindak lanjut (opsional).'; rec.value = finding?.recommendation_text ?? '';
      const wrapStatus = document.createElement('label'); wrapStatus.textContent = 'Hasil'; wrapStatus.append(status);
      const wrapAnalysis = document.createElement('label'); wrapAnalysis.textContent = 'Analisis'; wrapAnalysis.append(analysis);
      const wrapRec = document.createElement('label'); wrapRec.textContent = 'Rekomendasi'; wrapRec.append(rec);
      const save = el('button', finding ? 'Perbarui hasil' : 'Simpan hasil', 'secondary'); save.type = 'button'; save.addEventListener('click', async () => { try { show('Menyimpan hasil...'); await invoke({ action:'SAVE_FINDING', caseId:data.case.id, allegationId:allegation.id, findingStatus:status.value, analysisText:analysis.value, recommendationText:rec.value }); show('Hasil pemeriksaan tersimpan.'); await loadDetail(data.case.id); } catch(e) { show(e.message,'error'); } });
      card.append(wrapStatus, wrapAnalysis, wrapRec, save);
    } else if (finding) {
      card.append(el('p', FINDING[finding.finding_status] ?? finding.finding_status, 'status-badge'), el('h4', 'Analisis'), el('p', finding.analysis_text, 'case-copy'));
      if (finding.recommendation_text) card.append(el('h4', 'Rekomendasi'), el('p', finding.recommendation_text, 'case-copy'));
    } else card.append(el('p', 'Hasil belum diisi.', 'muted'));
    p.append(card);
  }
  if (editable && role === 'CASE_LEAD') {
    const submit = el('div', null, 'action-card'); submit.append(el('h3', 'Kirim hasil ke Sekretariat'), el('p', 'Setelah dikirim, case berpindah ke Hasil Sedang Ditinjau dan workspace menjadi hanya-baca sampai ada keputusan.', 'muted'));
    const b = el('button', 'Kirim hasil pemeriksaan', 'primary'); b.type = 'button'; b.addEventListener('click', async () => { if(!confirm('Kirim hasil pemeriksaan ke Sekretariat?')) return; try { show('Memeriksa kelengkapan hasil...'); await invoke({ action:'SUBMIT_FINDINGS', caseId:data.case.id }); show('Hasil berhasil dikirim ke Sekretariat.'); await loadCases(); } catch(e) { show(e.message,'error'); } }); submit.append(b); p.append(submit);
  }
  return p;
}

function renderNotes(data) {
  const p = el('section', null, 'case-section workspace-panel'); p.append(el('h3', 'Catatan pemeriksaan'));
  if (data.case.status === 'INVESTIGATION') {
    const form = el('div', null, 'action-card');
    const type = document.createElement('select'); Object.entries(NOTE).forEach(([v,t]) => { const o=document.createElement('option');o.value=v;o.textContent=t;type.append(o); });
    const title = document.createElement('input'); title.placeholder = 'Judul catatan (opsional)';
    const body = document.createElement('textarea'); body.rows = 4; body.placeholder = 'Catatan ini bersifat internal dan tidak terlihat oleh pelapor.';
    const b = el('button', 'Simpan catatan', 'secondary'); b.type = 'button'; b.addEventListener('click', async () => { try { await invoke({ action:'ADD_NOTE', caseId:data.case.id, noteType:type.value, title:title.value, body:body.value }); show('Catatan tersimpan.'); await loadDetail(data.case.id); } catch(e) { show(e.message,'error'); } });
    form.append(type,title,body,b); p.append(form);
  }
  if (!(data.notes ?? []).length) p.append(el('p','Belum ada catatan pemeriksaan.','empty-state'));
  for (const n of data.notes ?? []) { const card=el('div',null,'note-card'); card.append(el('p',`${NOTE[n.note_type]??n.note_type} · ${fmt(n.created_at)}`,'eyebrow')); if(n.title)card.append(el('h4',n.title)); card.append(el('p',n.body,'case-copy')); p.append(card); }
  return p;
}

function renderMessages(data) {
  const p = el('section', null, 'case-section workspace-panel'); p.append(el('h3','Komunikasi dengan pelapor'));
  if (data.case.status === 'INVESTIGATION' && ['CASE_LEAD','INVESTIGATOR'].includes(data.assignmentRole)) {
    const form=el('div',null,'action-card'); const t=document.createElement('textarea');t.rows=3;t.placeholder='Pesan ini akan dapat dilihat oleh pelapor.';
    const b=el('button','Kirim pesan','secondary');b.type='button';b.addEventListener('click',async()=>{try{await invoke({action:'SEND_REPORTER_MESSAGE',caseId:data.case.id,message:t.value});show('Pesan dikirim kepada pelapor.');await loadDetail(data.case.id);}catch(e){show(e.message,'error')}});form.append(t,b);p.append(form);
  }
  if (!(data.messages ?? []).length) p.append(el('p','Belum ada komunikasi.','empty-state'));
  for(const m of data.messages??[]){const card=el('div',null,'message-item');card.append(el('strong',m.sender_type==='REPORTER'?'Pelapor':'Tim Penanganan'),el('p',m.body),el('small',fmt(m.created_at)));p.append(card);}
  return p;
}

function renderEvidence(data) {
  const p=el('section',null,'case-section workspace-panel');p.append(el('h3','Bukti / Dokumen Pendukung'));
  p.append(el('div','Integrasi upload Google Drive belum diaktifkan pada batch ini. Metadata bukti yang sudah terdaftar tetap dapat ditampilkan di sini.','notice'));
  if(!(data.evidence??[]).length)p.append(el('p','Belum ada bukti terdaftar.','empty-state'));
  for(const e of data.evidence??[]){const card=el('div',null,'evidence-card');card.append(el('strong',e.original_filename||'Dokumen'),el('p',`${e.evidence_type||'Bukti'} · ${e.mime_type||'Tipe tidak diketahui'} · ${fmt(e.created_at)}`,'muted'));if(e.description)card.append(el('p',e.description,'case-copy'));p.append(card);}
  return p;
}

document.querySelector('#googleLogin')?.addEventListener('click',async()=>{const redirectTo=new URL(`investigation.html${UAT?'?uat=1':''}`,window.location.href).href;const{error}=await supabaseClient.auth.signInWithOAuth({provider:'google',options:{redirectTo}});if(error){loginMessage.textContent=error.message;loginMessage.hidden=false;}});
document.querySelector('#logoutButton')?.addEventListener('click',async()=>{await supabaseClient.auth.signOut();location.reload();});
document.querySelector('#refreshButton')?.addEventListener('click',loadCases);
await authorize();
