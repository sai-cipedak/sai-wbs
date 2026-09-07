import { supabaseClient } from './supabase-client.js';
import { setBusy, showMessage } from './form-utils.js';

const loginPanel = document.querySelector('#loginPanel');
const statusPanel = document.querySelector('#profileStatus');
const form = document.querySelector('#profileForm');
const childrenList = document.querySelector('#childrenList');
const verificationPanel = document.querySelector('#verificationPanel');
const accessCodeLabel = document.querySelector('#accessCodeLabel');
const legacyNotice = document.querySelector('#legacyNotice');
const message = document.querySelector('#formMessage');
const saveButton = document.querySelector('#saveProfile');
let context = null;

function safeReturnTo() {
  const value = new URLSearchParams(location.search).get('returnTo') || 'index.html';
  return /^[a-z0-9-]+\.html(?:\?[^#]*)?$/i.test(value) ? value : 'index.html';
}

async function invoke(body) {
  const { data, error } = await supabaseClient.functions.invoke('reporter-profile', { body });
  if (error) {
    let detail = error.message;
    try { const payload = await error.context?.json(); if (payload?.error) detail = payload.error; } catch (_) { /* keep default */ }
    throw new Error(detail || 'Profile belum dapat diproses.');
  }
  return data;
}

function childRow(child = {}) {
  const row = document.createElement('div');
  row.className = 'child-row';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Nama anak';
  const name = document.createElement('input');
  name.className = 'child-name';
  name.maxLength = 160;
  name.required = true;
  name.value = child.name || '';
  nameLabel.append(name);
  const classLabel = document.createElement('label');
  classLabel.textContent = 'Kelas atau angkatan';
  const classInput = document.createElement('input');
  classInput.className = 'child-class';
  classInput.maxLength = 100;
  classInput.placeholder = 'Contoh: Kelas 4 / Angkatan 2023';
  classInput.required = true;
  classInput.value = child.classOrCohort || '';
  classLabel.append(classInput);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger-button child-remove';
  remove.textContent = 'Hapus';
  remove.addEventListener('click', () => {
    if (childrenList.children.length <= 1) return;
    row.remove();
  });
  row.append(nameLabel, classLabel, remove);
  return row;
}

function fillForm(status) {
  document.querySelector('#profileEmail').value = status.email || '';
  document.querySelector('#academicYear').value = status.academicYear || '';
  document.querySelector('#displayName').value = status.profile?.displayName || '';
  document.querySelector('#phone').value = status.reporterProfile?.phone || '';
  childrenList.replaceChildren();
  for (const child of status.children?.length ? status.children : [{}]) childrenList.append(childRow(child));
  const needsVerification = !status.reporterProfile || status.reporterProfile.reportingStatus === 'EXPIRED';
  verificationPanel.hidden = !needsVerification;
  accessCodeLabel.hidden = status.legacyEligible;
  legacyNotice.hidden = !status.legacyEligible;
  document.querySelector('#communityAccessCode').required = needsVerification && !status.legacyEligible;
  document.querySelector('#consent').required = needsVerification;
  document.querySelector('#formTitle').textContent = status.reporterProfile ? 'Perbarui data diri' : 'Data diri';
  saveButton.textContent = needsVerification ? 'Simpan dan lanjutkan' : 'Simpan perubahan';
}

function showStatus(status) {
  statusPanel.replaceChildren();
  statusPanel.hidden = true;
  if (status.accountInactive) {
    statusPanel.className = 'result-card status-blocked';
    statusPanel.append(Object.assign(document.createElement('h2'), { textContent: 'Akun dinonaktifkan' }), Object.assign(document.createElement('p'), { textContent: 'Hubungi pengelola portal untuk memulihkan akses akun.' }));
    statusPanel.hidden = false;
    form.hidden = true;
    return false;
  }
  if (status.internalInvitationPending) {
    location.replace('access.html');
    return false;
  }
  if (status.internalAccess) {
    statusPanel.className = 'result-card success';
    statusPanel.append(Object.assign(document.createElement('h2'), { textContent: 'Akun internal sudah aktif' }), Object.assign(document.createElement('p'), { textContent: 'Akun internal tidak memerlukan verifikasi profile OTS.' }));
    const home = Object.assign(document.createElement('a'), { href: 'index.html', textContent: 'Kembali ke beranda', className: 'button primary' });
    statusPanel.append(home);
    statusPanel.hidden = false;
    form.hidden = true;
    return false;
  }
  if (status.reporterProfile?.reportingStatus === 'SUSPENDED') {
    statusPanel.className = 'result-card status-blocked';
    statusPanel.append(Object.assign(document.createElement('h2'), { textContent: 'Akses laporan baru ditangguhkan' }), Object.assign(document.createElement('p'), { textContent: 'Anda tetap dapat login dan membuka laporan lama. Hubungi pengelola portal bila memerlukan peninjauan.' }));
    const reports = Object.assign(document.createElement('a'), { href: 'my-reports.html', textContent: 'Buka laporan saya', className: 'button secondary' });
    statusPanel.append(reports);
    statusPanel.hidden = false;
  } else if (status.reporterProfile?.reportingStatus === 'EXPIRED') {
    statusPanel.className = 'result-card';
    statusPanel.append(Object.assign(document.createElement('h2'), { textContent: 'Verifikasi perlu diperbarui' }), Object.assign(document.createElement('p'), { textContent: `Lengkapi konfirmasi untuk tahun ajaran ${status.academicYear}.` }));
    statusPanel.hidden = false;
  }
  return true;
}

async function load() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session?.user) {
    loginPanel.hidden = false;
    form.hidden = true;
    return;
  }
  loginPanel.hidden = true;
  try {
    context = await invoke({ action: 'STATUS' });
    const mayEdit = showStatus(context);
    if (mayEdit) {
      fillForm(context);
      form.hidden = false;
    }
  } catch (error) {
    statusPanel.className = 'result-card status-blocked';
    statusPanel.textContent = error.message || 'Profile belum dapat dimuat.';
    statusPanel.hidden = false;
  }
}

document.querySelector('#addChild')?.addEventListener('click', () => {
  if (childrenList.children.length >= 10) {
    showMessage(message, 'Maksimum 10 data anak.', 'error');
    return;
  }
  childrenList.append(childRow());
});

document.querySelector('#googleLogin')?.addEventListener('click', async () => {
  const redirectTo = location.href.split('#')[0];
  const { error } = await supabaseClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) showMessage(document.querySelector('#loginMessage'), error.message, 'error');
});

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const children = [...childrenList.querySelectorAll('.child-row')].map((row) => ({
    name: row.querySelector('.child-name').value.trim(),
    classOrCohort: row.querySelector('.child-class').value.trim(),
  }));
  const needsVerification = !context.reporterProfile || context.reporterProfile.reportingStatus === 'EXPIRED';
  const body = {
    action: needsVerification ? 'COMPLETE' : 'UPDATE',
    displayName: document.querySelector('#displayName').value.trim(),
    phone: document.querySelector('#phone').value.trim(),
    children,
    communityAccessCode: document.querySelector('#communityAccessCode').value.trim(),
    consent: document.querySelector('#consent').checked,
  };
  setBusy(saveButton, true, 'Menyimpan…');
  message.hidden = true;
  try {
    await invoke(body);
    location.replace(safeReturnTo());
  } catch (error) {
    showMessage(message, error.message || 'Profile belum dapat disimpan.', 'error');
  } finally {
    setBusy(saveButton, false);
  }
});

await load();
supabaseClient.auth.onAuthStateChange(() => load());
