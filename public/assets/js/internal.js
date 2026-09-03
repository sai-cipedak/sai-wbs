import { supabaseClient } from './supabase-client.js';

const loginPanel = document.querySelector('#loginPanel');
const dashboardPanel = document.querySelector('#dashboardPanel');
const loginMessage = document.querySelector('#loginMessage');
const userLabel = document.querySelector('#userLabel');
const caseList = document.querySelector('#caseList');
const caseDetail = document.querySelector('#caseDetail');
const pageMessage = document.querySelector('#pageMessage');
let currentCases = [];
let selectedCaseId = null;
let allowUat = false;

const STATUS_LABELS = {
  SUBMITTED: 'Laporan Diterima', UNDER_REVIEW: 'Sedang Ditelaah', MORE_INFO_REQUIRED: 'Informasi Tambahan Diperlukan',
  REFERRED_GRIEVANCE: 'Dirujuk ke Pengaduan', REFERRED_SAFEGUARDING: 'Dirujuk ke HSE', COMMITTEE_FORMATION: 'Menunggu Pembentukan Tim',
  INVESTIGATION: 'Pemeriksaan', AUTHORITY_REVIEW: 'Review Otoritas', REMEDIATION: 'Tindak Lanjut', CLOSED: 'Selesai', OUT_OF_SCOPE: 'Tidak Dilanjutkan',
};
const CLASS_LABELS = { INTEGRITY: 'Pelanggaran Integritas', SAFEGUARDING: 'Keselamatan & Perlindungan Anak', GRIEVANCE: 'Keluhan / Pengaduan Layanan', OUT_OF_SCOPE: 'Di Luar Ruang Lingkup' };

function fmtDate(value) { return value ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'; }
function el(tag, text, className) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; }
function showMessage(text, kind = 'info') { pageMessage.textContent = text; pageMessage.className = `form-message internal-message ${kind}`; pageMessage.hidden = !text; }
function roleActive(rows, code) {
  const now = Date.now();
  return (rows ?? []).filter((r) => r.role_code === code).some((r) => new Date(r.active_from).getTime() <= now && (!r.active_until || now < new Date(r.active_until).getTime()));
}

async function getSession() { return (await supabaseClient.auth.getSession()).data.session; }

async function authorize() {
  const session = await getSession();
  if (!session?.user) { loginPanel.hidden = false; dashboardPanel.hidden = true; return; }
  userLabel.textContent = session.user.email || 'Akun internal';
  const { data: roles, error } = await supabaseClient.from('user_system_roles')
    .select('role_code, active_from, active_until')
    .eq('user_id', session.user.id)
    .in('role_code', ['TRIAGE', 'SYSTEM_ADMIN']);
  const active = !error && roleActive(roles, 'TRIAGE');
  if (!active) {
    loginPanel.hidden = false; dashboardPanel.hidden = true;
    loginMessage.textContent = 'Akun ini belum memiliki kewenangan Penelaah Awal.'; loginMessage.className = 'form-message error'; loginMessage.hidden = false;
    return;
  }
  const requestedUat = new URLSearchParams(location.search).get('uat') === '1';
  allowUat = requestedUat && roleActive(roles, 'SYSTEM_ADMIN');
  loginPanel.hidden = true; dashboardPanel.hidden = false;
  if (requestedUat && !allowUat) showMessage('Mode UAT hanya tersedia untuk SYSTEM_ADMIN aktif.', 'error');
  else if (allowUat) showMessage('Mode UAT aktif — hanya data test yang ditampilkan.');
  await loadCases();
}

async function loadCases() {
  const preservedMessage = allowUat ? 'Mode UAT aktif — hanya data test yang ditampilkan.' : '';
  showMessage(preservedMessage);
  let query = supabaseClient.from('cases')
    .select('id, public_case_id, reporting_mode, status, classification, authority_code, submitted_at, is_test_data, test_label')
    .eq('authority_code', 'TRIAGE')
    .not('status', 'in', '(CLOSED,OUT_OF_SCOPE)');
  query = query.eq('is_test_data', allowUat);
  const { data, error } = await query.order('submitted_at', { ascending: false });
  if (error) { showMessage('Antrean laporan belum dapat dimuat.', 'error'); return; }
  currentCases = data ?? [];
  renderCaseList();
  if (selectedCaseId && currentCases.some((c) => c.id === selectedCaseId)) await selectCase(selectedCaseId);
  else if (currentCases.length) await selectCase(currentCases[0].id);
  else renderEmptyDetail();
}

function renderCaseList() {
  caseList.replaceChildren();
  if (!currentCases.length) { caseList.append(el('p', 'Tidak ada laporan yang menunggu Penelaahan Awal.', 'empty-state')); return; }
  for (const item of currentCases) {
    const button = el('button', null, `case-list-button${item.id === selectedCaseId ? ' active' : ''}`);
    button.type = 'button'; button.dataset.caseId = item.id;
    button.append(el('strong', item.public_case_id), el('span', STATUS_LABELS[item.status] ?? item.status), el('span', fmtDate(item.submitted_at)));
    if (item.is_test_data) button.append(el('span', `UAT${item.test_label ? ` · ${item.test_label}` : ''}`, 'status-badge'));
    button.addEventListener('click', () => selectCase(item.id));
    caseList.append(button);
  }
}

async function selectCase(caseId) {
  selectedCaseId = caseId; renderCaseList();
  const item = currentCases.find((c) => c.id === caseId); if (!item) return renderEmptyDetail();
  const [reportResult, messageResult] = await Promise.all([
    supabaseClient.from('case_reports').select('*').eq('case_id', caseId).single(),
    supabaseClient.from('case_messages').select('id, sender_type, body, visible_to_reporter, created_at').eq('case_id', caseId).order('created_at', { ascending: true }),
  ]);
  if (reportResult.error) { showMessage('Detail laporan belum dapat dimuat.', 'error'); return; }
  renderDetail(item, reportResult.data, messageResult.data ?? []);
}

function renderEmptyDetail() {
  caseDetail.replaceChildren(el('p', 'Pilih laporan dari antrean untuk melihat detail.', 'empty-state'));
}

function renderDetail(item, report, messages) {
  caseDetail.replaceChildren();
  const head = el('section', null, 'case-section');
  const title = el('h2', report.title || item.public_case_id);
  const badge = el('span', STATUS_LABELS[item.status] ?? item.status, 'status-badge');
  const statusHead = el('div', null, 'status-head'); statusHead.append(title, badge); head.append(statusHead);
  const meta = el('div', null, 'case-meta');
  const metaItems = [
    ['Nomor Laporan', item.public_case_id], ['Pelapor', item.reporting_mode === 'ANONYMOUS' ? 'Tanpa Identitas' : 'Identitas Dirahasiakan'],
    ['Klasifikasi', item.classification ? CLASS_LABELS[item.classification] : 'Belum ditentukan'], ['Diterima', fmtDate(item.submitted_at)],
  ];
  for (const [label, value] of metaItems) { const box = el('div'); box.append(el('span', label), el('strong', value)); meta.append(box); }
  head.append(meta);
  if (item.is_test_data) { const note = el('div', null, 'notice'); note.append(el('strong', 'Data UAT / Test'), el('p', item.test_label || 'Case ini ditandai sebagai data pengujian.')); head.append(note); }
  caseDetail.append(head);

  const story = el('section', null, 'case-section'); story.append(el('h3', 'Uraian laporan'), el('p', report.narrative, 'case-copy'));
  if (report.people_involved_text) story.append(el('h3', 'Pihak terkait'), el('p', report.people_involved_text, 'case-copy'));
  const detailBits = [report.incident_date ? `Tanggal: ${report.incident_date}` : null, report.incident_time_text ? `Waktu: ${report.incident_time_text}` : null, report.location_text ? `Lokasi: ${report.location_text}` : null].filter(Boolean);
  if (detailBits.length) story.append(el('p', detailBits.join(' · '), 'muted'));
  if (report.child_safety_risk || report.ongoing_risk) story.append(el('p', 'PERHATIAN: laporan memiliki indikator keselamatan/perlindungan.', 'form-message error'));
  caseDetail.append(story);

  const msgSection = el('section', null, 'case-section'); msgSection.append(el('h3', 'Komunikasi dengan pelapor'));
  if (!messages.length) msgSection.append(el('p', 'Belum ada pesan.', 'muted'));
  for (const msg of messages) { const box = el('div', null, 'message-item'); box.append(el('strong', msg.sender_type === 'REPORTER' ? 'Pelapor' : 'Tim Penanganan'), el('p', msg.body), el('small', fmtDate(msg.created_at))); msgSection.append(box); }
  caseDetail.append(msgSection);

  const actions = el('section', null, 'case-section action-stack'); actions.append(el('h3', 'Penelaahan Awal'));
  if (['SUBMITTED', 'MORE_INFO_REQUIRED'].includes(item.status)) {
    const start = el('button', 'Mulai Penelaahan', 'primary'); start.type = 'button'; start.addEventListener('click', () => runAction('START_REVIEW', item.id, {})); actions.append(start);
  }

  const requestCard = el('div', null, 'action-card'); requestCard.append(el('h3', 'Minta informasi tambahan'));
  const requestText = document.createElement('textarea'); requestText.rows = 3; requestText.placeholder = 'Tulis pertanyaan yang aman untuk dilihat pelapor.'; requestCard.append(requestText);
  const requestBtn = el('button', 'Kirim permintaan informasi', 'secondary'); requestBtn.type = 'button'; requestBtn.addEventListener('click', () => runAction('REQUEST_INFO', item.id, { reporterMessage: requestText.value })); requestCard.append(requestBtn); actions.append(requestCard);

  const routeCard = el('div', null, 'action-card'); routeCard.append(el('h3', 'Klasifikasi dan rujuk'));
  const reason = document.createElement('textarea'); reason.rows = 3; reason.placeholder = 'Catatan alasan klasifikasi (internal, wajib).'; routeCard.append(reason);
  const routeRow = el('div', null, 'action-row');
  [['ROUTE_INTEGRITY','Integritas'],['ROUTE_SAFEGUARDING','Perlindungan Anak'],['ROUTE_GRIEVANCE','Pengaduan Layanan'],['ROUTE_DEKOM','Ambil Alih Dekom']].forEach(([action,label]) => { const b = el('button', label, 'secondary'); b.type='button'; b.addEventListener('click', () => runAction(action, item.id, { internalReason: reason.value })); routeRow.append(b); });
  routeCard.append(routeRow); actions.append(routeCard);

  const closeCard = el('div', null, 'action-card danger-zone'); closeCard.append(el('h3', 'Tutup sebagai di luar ruang lingkup'));
  const internalReason = document.createElement('textarea'); internalReason.rows=2; internalReason.placeholder='Alasan internal (wajib).';
  const reporterExplanation = document.createElement('textarea'); reporterExplanation.rows=2; reporterExplanation.placeholder='Penjelasan yang akan dilihat pelapor (wajib).';
  const closeBtn = el('button', 'Tutup laporan', 'secondary'); closeBtn.type='button'; closeBtn.addEventListener('click', () => runAction('CLOSE_OUT_OF_SCOPE', item.id, { internalReason: internalReason.value, reporterExplanation: reporterExplanation.value }));
  closeCard.append(internalReason, reporterExplanation, closeBtn); actions.append(closeCard);
  caseDetail.append(actions);
}

async function runAction(action, caseId, payload) {
  showMessage('Menyimpan perubahan...');
  const { data, error } = await supabaseClient.functions.invoke('triage-case-action', { body: { action, caseId, includeTestData: allowUat, ...payload } });
  if (error) {
    let detail = error.message;
    try { const context = await error.context?.json(); if (context?.error) detail = context.error; } catch (_) {}
    showMessage(detail || 'Aksi belum dapat disimpan.', 'error'); return;
  }
  showMessage(`Perubahan untuk ${data.nomorLaporan} berhasil disimpan.`); await loadCases();
}

document.querySelector('#googleLogin')?.addEventListener('click', async () => {
  const redirectTo = new URL(`internal.html${location.search}`, window.location.href).href;
  const { error } = await supabaseClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) { loginMessage.textContent = error.message; loginMessage.hidden = false; }
});
document.querySelector('#logoutButton')?.addEventListener('click', async () => { await supabaseClient.auth.signOut(); location.reload(); });
document.querySelector('#refreshButton')?.addEventListener('click', loadCases);

await authorize();
supabaseClient.auth.onAuthStateChange(() => authorize());
