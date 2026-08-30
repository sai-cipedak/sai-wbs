import { invokePublic } from './supabase-client.js';
import { setBusy, showMessage } from './form-utils.js';
import { mountAnonymousEvidence } from './reporter-evidence.js?v=20260830-1';

const form = document.querySelector('#checkReportForm');
const message = document.querySelector('#formMessage');
const result = document.querySelector('#reportResult');
const replyForm = document.querySelector('#replyForm');
const replyMessage = document.querySelector('#replyMessage');
const evidenceHost = document.querySelector('#anonymousEvidence');
let currentCredentials = null;

async function loadReport(credentials) {
  const data = await invokePublic('check-anonymous-report', credentials);
  document.querySelector('#resultTitle').textContent = data.judul;
  document.querySelector('#resultCaseNumber').textContent = data.nomorLaporan;
  document.querySelector('#resultStatus').textContent = data.status;
  document.querySelector('#resultClassification').textContent = data.klasifikasi || 'Belum ditentukan';
  document.querySelector('#resultDate').textContent = new Date(data.tanggalLaporan).toLocaleString('id-ID');

  const finalOutcome = document.querySelector('#resultFinalOutcome');
  const outcomeList = document.querySelector('#resultOutcomeList');
  const outcomeSummary = document.querySelector('#resultOutcomeSummary');
  const outcomeDate = document.querySelector('#resultOutcomeDate');
  outcomeList.replaceChildren();
  if (data.hasilAkhir) {
    finalOutcome.hidden = false;
    (data.hasilAkhir.hasil ?? []).forEach((item) => {
      const row = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = `Dugaan ${item.dugaan}: ${item.hasil}`;
      row.append(strong); outcomeList.append(row);
    });
    outcomeSummary.textContent = data.hasilAkhir.ringkasan || '';
    outcomeDate.textContent = data.hasilAkhir.waktu ? `Diselesaikan: ${new Date(data.hasilAkhir.waktu).toLocaleString('id-ID')}` : '';
  } else {
    finalOutcome.hidden = true;
    outcomeSummary.textContent = '';
    outcomeDate.textContent = '';
  }

  const messages = document.querySelector('#resultMessages');
  messages.replaceChildren();
  if (!data.pesan?.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Belum ada pesan baru.'; messages.append(empty);
  } else data.pesan.forEach((item) => {
    const article = document.createElement('article'); article.className = 'message-item';
    const head = document.createElement('strong'); head.textContent = item.dari;
    const body = document.createElement('p'); body.textContent = item.isi;
    const time = document.createElement('small'); time.textContent = new Date(item.waktu).toLocaleString('id-ID');
    article.append(head, body, time); messages.append(article);
  });
  result.hidden = false;
  replyForm.hidden = data.canReply === false;
  if (evidenceHost) {
    evidenceHost.replaceChildren();
    mountAnonymousEvidence(evidenceHost, credentials).catch((error) => {
      const box = document.createElement('div');
      box.className = 'form-message error';
      box.textContent = error.message || 'Bukti belum dapat dimuat.';
      evidenceHost.replaceChildren(box);
    });
  }
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  const values = new FormData(form);
  const credentials = {
    nomorLaporan: String(values.get('nomorLaporan') || '').trim().toUpperCase(),
    kunciRahasia: String(values.get('kunciRahasia') || '').trim().toUpperCase(),
  };
  setBusy(button, true, 'Memeriksa…');
  message.hidden = true;
  try {
    await loadReport(credentials);
    currentCredentials = credentials;
  } catch (error) {
    result.hidden = true;
    evidenceHost?.replaceChildren();
    currentCredentials = null;
    showMessage(message, error instanceof Error ? error.message : 'Laporan belum dapat diperiksa.', 'error');
  } finally { setBusy(button, false, 'Memeriksa…'); }
});

replyForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentCredentials) return;
  const button = replyForm.querySelector('button[type="submit"]');
  const values = new FormData(replyForm);
  setBusy(button, true, 'Mengirim…');
  replyMessage.hidden = true;
  try {
    await invokePublic('send-anonymous-message', { ...currentCredentials, pesan: String(values.get('pesan') || '').trim() });
    replyForm.reset();
    showMessage(replyMessage, 'Pesan berhasil dikirim.', 'info');
    await loadReport(currentCredentials);
  } catch (error) {
    showMessage(replyMessage, error instanceof Error ? error.message : 'Pesan belum dapat dikirim.', 'error');
  } finally { setBusy(button, false); }
});