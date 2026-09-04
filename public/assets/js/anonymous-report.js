import { invokePublic } from './supabase-client.js';
import { getIntakePayload, setBusy, showMessage } from './form-utils.js';
import { mountAnonymousEvidence } from './reporter-evidence.js?v=20260904-1';

const form = document.querySelector('#anonymousReportForm');
const message = document.querySelector('#formMessage');
const result = document.querySelector('#successResult');
const caseNumber = document.querySelector('#resultCaseNumber');
const secretKey = document.querySelector('#resultSecretKey');
const evidenceContainer = document.querySelector('#initialEvidence');
const ATTEMPT_KEY = 'sai-wbs:anonymous-report-attempt:v1';
const BASE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
let inFlight = false;
let memoryAttempt = null;

function generateSecretKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const raw = Array.from(bytes, (b) => BASE32[b % BASE32.length]).join('');
  return `WBS-${raw.slice(0,5)}-${raw.slice(5,10)}-${raw.slice(10,15)}-${raw.slice(15,20)}`;
}

async function fingerprint(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function loadAttempt() {
  try {
    const raw = sessionStorage.getItem(ATTEMPT_KEY);
    return raw ? JSON.parse(raw) : memoryAttempt;
  } catch (_) { return memoryAttempt; }
}

function saveAttempt(value) {
  memoryAttempt = value;
  try { sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(value)); } catch (_) {}
}

function clearAttempt() {
  memoryAttempt = null;
  try { sessionStorage.removeItem(ATTEMPT_KEY); } catch (_) {}
}

async function attemptFor(payload) {
  const fp = await fingerprint(payload);
  const existing = loadAttempt();
  if (existing?.fingerprint === fp && existing?.token && existing?.secret) return existing;
  const next = { fingerprint: fp, token: crypto.randomUUID(), secret: generateSecretKey() };
  saveAttempt(next);
  return next;
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (inFlight) return;
  const button = form.querySelector('button[type="submit"]');
  inFlight = true;
  setBusy(button, true, 'Mengirim laporan…');
  message.hidden = true;
  try {
    const payload = {
      ...getIntakePayload(form),
      communityAccessCode: String(new FormData(form).get('communityAccessCode') || '').trim().toUpperCase(),
    };
    const attempt = await attemptFor(payload);
    const data = await invokePublic('submit-anonymous-report', {
      ...payload,
      submissionToken: attempt.token,
      anonymousSecret: attempt.secret,
    });
    caseNumber.textContent = data.nomorLaporan;
    secretKey.textContent = data.kunciRahasia;
    form.hidden = true;
    result.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    clearAttempt();
    if (evidenceContainer) {
      evidenceContainer.hidden = false;
      try {
        await mountAnonymousEvidence(evidenceContainer, {
          nomorLaporan: data.nomorLaporan,
          kunciRahasia: data.kunciRahasia,
        });
      } catch (evidenceError) {
        evidenceContainer.replaceChildren();
        const note = document.createElement('p');
        note.className = 'form-message error';
        note.textContent = `${evidenceError.message || 'Bukti belum dapat dimuat.'} Laporan Anda tetap sudah tersimpan; bukti dapat ditambahkan nanti melalui Cek Laporan menggunakan Nomor Laporan dan Kunci Rahasia.`;
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
