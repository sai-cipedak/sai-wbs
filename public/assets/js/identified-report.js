import { supabaseClient } from './supabase-client.js';
import { getIntakePayload, setBusy, showMessage } from './form-utils.js';

const loginPanel = document.querySelector('#loginPanel');
const formPanel = document.querySelector('#identifiedFormPanel');
const form = document.querySelector('#identifiedReportForm');
const identityLabel = document.querySelector('#identityLabel');
const message = document.querySelector('#formMessage');
const result = document.querySelector('#successResult');

async function refreshSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session?.user) {
    loginPanel.hidden = true;
    formPanel.hidden = false;
    identityLabel.textContent = session.user.email || 'Akun Google terverifikasi';
  } else {
    loginPanel.hidden = false;
    formPanel.hidden = true;
  }
}

await refreshSession();
supabaseClient.auth.onAuthStateChange(() => { refreshSession(); });

document.querySelector('#googleLogin')?.addEventListener('click', async () => {
  const redirectTo = new URL('lapor-identitas.html', window.location.href).href;
  const { error } = await supabaseClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) showMessage(document.querySelector('#loginMessage'), error.message, 'error');
});

document.querySelector('#logoutButton')?.addEventListener('click', async () => { await supabaseClient.auth.signOut(); });

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  setBusy(button, true);
  message.hidden = true;
  try {
    const { data, error } = await supabaseClient.functions.invoke('submit-identified-report', { body: getIntakePayload(form) });
    if (error) {
      let detail = error.message;
      try { const context = await error.context?.json(); if (context?.error) detail = context.error; } catch (_) { /* keep default */ }
      throw new Error(detail);
    }
    document.querySelector('#resultCaseNumber').textContent = data.nomorLaporan;
    document.querySelector('#identityProtection').textContent = data.identityProtection;
    formPanel.hidden = true;
    result.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (error) {
    showMessage(message, error instanceof Error ? error.message : 'Laporan belum dapat dikirim.', 'error');
  } finally { setBusy(button, false); }
});
