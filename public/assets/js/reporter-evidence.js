import { supabaseClient } from './supabase-client.js';

const EDGE_URL = `${window.WBS_CONFIG.SUPABASE_URL}/functions/v1/evidence-action`;
const API_KEY = window.WBS_CONFIG.SUPABASE_PUBLISHABLE_KEY;
const REVIEW_LABEL = {
  PENDING_REVIEW: 'Menunggu review tim penanganan',
  CLEARED: 'Sudah ditinjau',
  RESTRICTED: 'Akses dibatasi oleh tim penanganan',
};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formatSize(value) {
  const bytes = Number(value ?? 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function makeAccess(kind, value) {
  if (kind === 'IDENTIFIED') {
    if (value && typeof value === 'object') {
      if (value.caseId) return { kind, caseId: value.caseId };
      if (value.publicCaseId) return { kind, publicCaseId: value.publicCaseId };
    }
    return { kind, caseId: value };
  }
  return { kind, nomorLaporan: value.nomorLaporan, kunciRahasia: value.kunciRahasia };
}

async function authHeaders(access) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: API_KEY,
  };
  if (access.kind === 'IDENTIFIED') {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.access_token) throw new Error('Sesi pelapor berakhir. Silakan masuk kembali.');
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  return headers;
}

function payload(access, body) {
  if (access.kind === 'IDENTIFIED') {
    const caseRef = access.caseId ? { caseId: access.caseId } : { publicCaseId: access.publicCaseId };
    return { ...body, ...caseRef, actorContext: 'REPORTER' };
  }
  return { ...body, nomorLaporan: access.nomorLaporan, kunciRahasia: access.kunciRahasia, actorContext: 'REPORTER' };
}

async function request(access, body, expectBlob = false) {
  const response = await fetch(EDGE_URL, {
    method: 'POST',
    headers: await authHeaders(access),
    body: JSON.stringify(payload(access, body)),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'Bukti belum dapat diproses.');
  }
  return expectBlob ? response : response.json();
}

async function sha256(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function setMessage(section, text, kind = 'info') {
  const node = section.querySelector('.reporter-evidence-message');
  if (!node) return;
  node.textContent = text;
  node.className = `reporter-evidence-message form-message ${kind}`;
  node.hidden = !text;
}

async function download(access, item, section) {
  setMessage(section, 'Menyiapkan file...');
  const response = await request(access, { action: 'DOWNLOAD', evidenceId: item.id }, true);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = item.original_filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  setMessage(section, 'File berhasil diakses. Akses dicatat di audit trail.', 'success');
}

function evidenceCard(access, item, section) {
  const card = el('article', null, 'evidence-card');
  const head = el('div', null, 'evidence-card-head');
  const info = el('div');
  info.append(
    el('strong', item.original_filename),
    el('p', `${formatSize(item.file_size_bytes)} · ${item.mime_type}`, 'muted'),
  );
  head.append(info, el('span', item.status === 'ACTIVE' ? 'Tersimpan' : item.status, 'status-badge'));
  card.append(head);
  if (item.description) card.append(el('p', item.description, 'case-copy'));
  card.append(el('p', REVIEW_LABEL[item.review_state] ?? item.review_state, 'muted-small'));
  if (item.status === 'ACTIVE') {
    const row = el('div', null, 'action-row evidence-actions');
    const button = el('button', 'Unduh file', 'secondary');
    button.type = 'button';
    button.addEventListener('click', () => download(access, item, section).catch((error) => setMessage(section, error.message, 'error')));
    row.append(button);
    card.append(row);
  }
  return card;
}

async function upload(access, section, data, refresh) {
  const fileInput = section.querySelector('.reporter-evidence-file');
  const description = section.querySelector('.reporter-evidence-description').value.trim();
  const file = fileInput.files?.[0];
  if (!file) throw new Error('Pilih file bukti terlebih dahulu.');
  const max = Number(data.policy.maxFileSizeBytes ?? 0);
  if (!file.size || file.size > max) throw new Error(`Ukuran file maksimum ${Math.round(max / 1048576)} MB.`);
  if (!data.policy.allowedMimeTypes.includes(file.type)) throw new Error('Tipe file belum diizinkan oleh kebijakan bukti.');

  const hashLimit = Number(data.policy.sha256VerifyMaxBytes ?? 0);
  setMessage(section, 'Menyiapkan upload privat...');
  const hash = file.size <= hashLimit ? await sha256(file) : null;
  const init = await request(access, {
    action: 'INIT_UPLOAD',
    originalFilename: file.name,
    mimeType: file.type,
    fileSizeBytes: file.size,
    sha256Hash: hash,
  });

  let uploadResponseReadable = false;
  try {
    const uploaded = await fetch(init.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    uploadResponseReadable = uploaded.ok;
    if (!uploaded.ok) throw new Error('Upload ke repositori privat gagal.');
  } catch (_) {
    // Google Drive can accept a cross-origin resumable upload while the browser cannot read the final response.
    // COMPLETE_UPLOAD / LIST performs authoritative metadata and hash verification before registration.
  }

  try {
    await request(access, { action: 'COMPLETE_UPLOAD', sessionId: init.sessionId, description });
  } catch (error) {
    if (uploadResponseReadable) throw error;
    setMessage(section, 'Upload telah dikirim. Server sedang memverifikasi file; tekan Muat Ulang Bukti bila file belum muncul.', 'info');
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  fileInput.value = '';
  section.querySelector('.reporter-evidence-description').value = '';
  await refresh();
}

async function render(container, access) {
  const data = await request(access, { action: 'LIST' });
  container.replaceChildren();
  const section = el('section', null, 'action-card evidence-workspace reporter-evidence');
  const title = el('div', null, 'evidence-title');
  const titleText = el('div');
  titleText.append(
    el('h3', 'Bukti Pendukung'),
    el('p', 'Punya dokumen, foto, rekaman, atau bukti lain? Anda dapat menambahkannya sekarang atau nanti. File disimpan privat dan harus direview sebelum dapat dibuka ke Tim Pemeriksa.', 'muted'),
  );
  const refreshButton = el('button', 'Muat Ulang Bukti', 'text-button');
  refreshButton.type = 'button';
  refreshButton.addEventListener('click', () => refresh().catch((error) => setMessage(section, error.message, 'error')));
  title.append(titleText, refreshButton);
  section.append(title, el('div', '', 'reporter-evidence-message form-message'));
  section.querySelector('.reporter-evidence-message').hidden = true;

  const list = el('div', null, 'evidence-list');
  if (!(data.evidence ?? []).length) list.append(el('p', 'Belum ada bukti yang Anda unggah untuk laporan ini.', 'empty-state'));
  else (data.evidence ?? []).forEach((item) => list.append(evidenceCard(access, item, section)));
  section.append(list);

  if (data.canUpload) {
    const uploadBox = el('div', null, 'evidence-upload');
    uploadBox.append(el('h4', 'Tambah bukti (opsional)'));
    const file = document.createElement('input');
    file.className = 'reporter-evidence-file';
    file.type = 'file';
    file.accept = data.policy.allowedMimeTypes.join(',');
    const description = document.createElement('textarea');
    description.className = 'reporter-evidence-description';
    description.rows = 2;
    description.maxLength = 2000;
    description.placeholder = 'Catatan singkat tentang file ini (opsional).';
    const uploadButton = el('button', 'Upload bukti', 'secondary');
    uploadButton.type = 'button';
    uploadButton.addEventListener('click', async () => {
      uploadButton.disabled = true;
      try {
        await upload(access, section, data, refresh);
      } catch (error) {
        setMessage(section, error.message, 'error');
      } finally {
        uploadButton.disabled = false;
      }
    });
    uploadBox.append(file, description, uploadButton, el('small', `Maksimum ${Math.round(data.policy.maxFileSizeBytes / 1048576)} MB per file. Upload dapat diulang untuk menambahkan beberapa file. Setelah disubmit, bukti menjadi bagian audit trail dan tidak dapat dihapus sendiri oleh pelapor.`));
    section.append(uploadBox);
  } else {
    section.append(el('p', 'Laporan sudah selesai; bukti baru tidak dapat ditambahkan.', 'muted'));
  }

  container.append(section);

  async function refresh() {
    await render(container, access);
  }
}

export async function mountIdentifiedEvidence(container, caseRef) {
  return render(container, makeAccess('IDENTIFIED', caseRef));
}

export async function mountAnonymousEvidence(container, credentials) {
  return render(container, makeAccess('ANONYMOUS', credentials));
}
