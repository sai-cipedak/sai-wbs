import { supabaseClient } from './supabase-client.js';
import { getIntakePayload, setBusy, showMessage } from './form-utils.js';
import { mountIdentifiedEvidence } from './reporter-evidence.js?v=20260830-2';

const loginPanel = document.querySelector('#loginPanel');
const formPanel = document.querySelector('#identifiedFormPanel');
const form = document.querySelector('#identifiedReportForm');
const identityLabel = document.querySelector('#identityLabel');
const message = document.querySelector('#formMessage');
const result = document.querySelector('#successResult');
const evidenceContainer = document.querySelector('#initialEvidence');
const ATTEMPT_KEY = 'sai-wbs:identified-report-attempt:v1';
let inFlight = false;
let memoryAttempt = null;

function attemptFor(payload) {
  const fingerprint = JSON.stringify(payload);
  let stored = memoryAttempt;
  try {
    const raw = sessionStorage.getItem(ATTEMPT_KEY);
    if (raw) stored = JSON.parse(raw);
  } catch (_) { /* use memory fallback */ }
  if (stored?.fingerprint === fingerprint && typeof stored?.token === 'string') return stored.token;
  const next = { fingerprint, token: crypto.randomUUID() };
  memoryAttempt = next;
  try { sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(next)); } catch (_) { /* memory fallback */ }
  return next.token;
}

function clearAttempt() {
  memoryAttempt = null;
  try { sessionStorage.removeItem(ATTEMPT_KEY); } catch (_) { /* no-op */ }
}

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
  if (inFlight) return;
  const button = form.querySelector('button[type="submit"]');
  const payload = getIntakePayload(form);
  payload.submissionToken = attemptFor(payload);
  inFlight = true;
  setBusy(button, true, 'Mengirim laporan…');
  message.hidden = true;
  try {
    const { data, error } = await supabaseClient.functions.invoke('submit-identified-report', { body: payload });
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
    clearAttempt();
    if (evidenceContainer) {
      evidenceContainer.hidden = false;
      try {
        await mountIdentifiedEvidence(evidenceContainer, { publicCaseId: data.nomorLaporan });
      } catch (evidenceError) {
        evidenceContainer.replaceChildren();
        const note = document.createElement('p');
        note.className = 'form-message error';
        note.textContent = `${evidenceError.message || 'Bukti belum dapat dimuat.'} Laporan Anda tetap sudah tersimpan; bukti dapat ditambahkan nanti dari Laporan Saya.`;
        evidenceContainer.append(note);
      }
    }
  } catch (error) {
    showMessage(message, error instanceof Error ? error.message : 'Laporan belum dapat dikirim.', 'error');
  } finally {
    inFlight = false;
    setBusy(button, false);
  }
});
