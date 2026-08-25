import { invokePublic } from './supabase-client.js';
import { getIntakePayload, setBusy, showMessage } from './form-utils.js';

const form = document.querySelector('#anonymousReportForm');
const message = document.querySelector('#formMessage');
const result = document.querySelector('#successResult');
const caseNumber = document.querySelector('#resultCaseNumber');
const secretKey = document.querySelector('#resultSecretKey');

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true);
  message.hidden = true;
  try {
    const payload = { ...getIntakePayload(form), communityAccessCode: String(new FormData(form).get('communityAccessCode') || '').trim().toUpperCase() };
    const data = await invokePublic('submit-anonymous-report', payload);
    caseNumber.textContent = data.nomorLaporan;
    secretKey.textContent = data.kunciRahasia;
    form.hidden = true;
    result.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    showMessage(message, error instanceof Error ? error.message : 'Laporan belum dapat dikirim.', 'error');
  } finally { setBusy(button, false); }
});

document.querySelectorAll('[data-copy-target]').forEach((button) => {
  button.addEventListener('click', async () => {
    const target = document.querySelector(button.dataset.copyTarget);
    if (!target?.textContent) return;
    await navigator.clipboard.writeText(target.textContent);
    const old = button.textContent;
    button.textContent = 'Tersalin';
    setTimeout(() => { button.textContent = old; }, 1200);
  });
});
