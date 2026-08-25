import { invokePublic } from './supabase-client.js';
import { setBusy, showMessage } from './form-utils.js';

const form = document.querySelector('#checkReportForm');
const message = document.querySelector('#formMessage');
const result = document.querySelector('#reportResult');

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  const values = new FormData(form);
  setBusy(button, true, 'Memeriksa…');
  message.hidden = true;
  try {
    const data = await invokePublic('check-anonymous-report', {
      nomorLaporan: String(values.get('nomorLaporan') || '').trim().toUpperCase(),
      kunciRahasia: String(values.get('kunciRahasia') || '').trim().toUpperCase(),
    });
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
  } catch (error) {
    result.hidden = true;
    showMessage(message, error instanceof Error ? error.message : 'Laporan belum dapat diperiksa.', 'error');
  } finally { setBusy(button, false, 'Memeriksa…'); }
});
