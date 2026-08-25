import { invokePublic } from './supabase-client.js';
import { setBusy, showMessage } from './form-utils.js';

const form = document.querySelector('#checkReportForm');
const message = document.querySelector('#formMessage');
const result = document.querySelector('#reportResult');
const replyForm = document.querySelector('#replyForm');
const replyMessage = document.querySelector('#replyMessage');
let currentCredentials = null;

async function loadReport(credentials) {
  const data = await invokePublic('check-anonymous-report', credentials);
  document.querySelector('#resultTitle').textContent = data.judul;
  document.querySelector('#resultCaseNumber').textContent = data.nomorLaporan;
  document.querySelector('#resultStatus').textContent = data.status;
  document.querySelector('#resultClassification').textContent = data.klasifikasi || 'Belum ditentukan';
  document.querySelector('#resultDate').textContent = new Date(data.tanggalLaporan).toLocaleString('id-ID');
  const messages = document.querySelector('#resultMessages');
  messages.innerHTML = '';
  if (!data.pesan?.length) messages.innerHTML = '<p class="muted">Belum ada pesan baru.</p>';
  else data.pesan.forEach((item) => {
    const article = document.createElement('article'); article.className = 'message-item';
    const head = document.createElement('strong'); head.textContent = item.dari;
    const body = document.createElement('p'); body.textContent = item.isi;
    const time = document.createElement('small'); time.textContent = new Date(item.waktu).toLocaleString('id-ID');
    article.append(head, body, time); messages.append(article);
  });
  result.hidden = false;
  replyForm.hidden = false;
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
