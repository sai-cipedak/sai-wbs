import { supabaseClient } from './supabase-client.js';

const detail = document.querySelector('#caseDetail');
const list = document.querySelector('#caseList');
let rendering = false;
let policy = null;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const size = (value) => {
  const bytes = Number(value ?? 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
};
const activeCaseId = () => list?.querySelector('[data-case-id].active')?.dataset.caseId || null;

async function invoke(body) {
  const { data, error } = await supabaseClient.functions.invoke('evidence-action', { body: { ...body, actorContext: 'INTERNAL' } });
  if (error) {
    let message = error.message;
    try { message = (await error.context?.json())?.error || message; } catch (_) {}
    throw new Error(message || 'Aksi bukti belum dapat diproses.');
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

async function sha256(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function message(section, text, kind = 'info') {
  const box = section.querySelector('.evidence-message');
  box.textContent = text;
  box.className = `evidence-message form-message ${kind}`;
  box.hidden = !text;
}

async function download(caseId, item, section) {
  message(section, 'Menyiapkan file...');
  const session = (await supabaseClient.auth.getSession()).data.session;
  const response = await fetch(`${window.WBS_CONFIG.SUPABASE_URL}/functions/v1/evidence-action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: window.WBS_CONFIG.SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${session?.access_token ?? ''}`,
    },
    body: JSON.stringify({ action: 'DOWNLOAD', caseId, evidenceId: item.id, actorContext: 'INTERNAL' }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'File belum dapat diunduh.');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = item.original_filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  message(section, 'Akses file dicatat di audit trail.', 'success');
}

function evidenceCard(caseId, item, canReview, section) {
  const card = document.createElement('article');
  card.className = 'evidence-card';
  const reporterLabel = item.uploader_context === 'INTERNAL' ? 'Internal' : 'Pelapor (identitas tidak ditampilkan)';
  card.innerHTML = `
    <div class="evidence-card-head"><div><strong>${esc(item.original_filename)}</strong><p>${esc(size(item.file_size_bytes))} · ${esc(item.mime_type)}</p></div><span class="status-badge">${esc(item.status)}</span></div>
    <p>${esc(item.description || 'Tanpa catatan')}</p>
    <p class="muted">Sumber: ${reporterLabel} · Review: ${esc(item.review_state)} · Scope: ${esc(item.access_scope)}</p>
    <div class="action-row evidence-actions"></div>`;
  const actions = card.querySelector('.evidence-actions');
  if (item.status === 'ACTIVE') {
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'secondary'; open.textContent = 'Unduh file';
    open.addEventListener('click', () => download(caseId, item, section).catch((e) => message(section, e.message, 'error')));
    actions.append(open);
  }
  if (canReview && item.status === 'ACTIVE') {
    const authority = document.createElement('button');
    authority.type = 'button'; authority.className = 'secondary'; authority.textContent = 'Batasi ke otoritas';
    authority.addEventListener('click', async () => {
      try {
        await invoke({ action: 'SET_REVIEW', caseId, evidenceId: item.id, reviewState: 'RESTRICTED', accessScope: 'AUTHORITY_ONLY', reviewNote: 'Dibatasi oleh otoritas case.' });
        await render(true);
      } catch (e) { message(section, e.message, 'error'); }
    });
    const team = document.createElement('button');
    team.type = 'button'; team.className = 'secondary'; team.textContent = 'Izinkan Tim Pemeriksa';
    team.addEventListener('click', async () => {
      try {
        await invoke({ action: 'SET_REVIEW', caseId, evidenceId: item.id, reviewState: 'CLEARED', accessScope: 'INVESTIGATION_TEAM' });
        await render(true);
      } catch (e) { message(section, e.message, 'error'); }
    });
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'text-button evidence-remove'; remove.textContent = 'Hapus';
    remove.addEventListener('click', async () => {
      const note = prompt('Alasan penghapusan (wajib, akan dicatat di audit trail):');
      if (!note) return;
      if (!confirm('File akan dipindahkan ke Trash Google Drive dan tidak dapat diakses dari portal. Lanjutkan?')) return;
      try {
        await invoke({ action: 'REMOVE', caseId, evidenceId: item.id, removalNote: note });
        await render(true);
      } catch (e) { message(section, e.message, 'error'); }
    });
    actions.append(authority, team, remove);
  }
  return card;
}

async function upload(caseId, section, listData) {
  const fileInput = section.querySelector('.evidence-file');
  const description = section.querySelector('.evidence-description').value.trim();
  const scope = section.querySelector('.evidence-scope').value;
  const file = fileInput.files?.[0];
  if (!file) throw new Error('Pilih file bukti terlebih dahulu.');
  const max = Number(listData.policy.maxFileSizeBytes ?? 0);
  if (!file.size || file.size > max) throw new Error(`Ukuran file maksimum ${Math.round(max / 1048576)} MB.`);
  if (!listData.policy.allowedMimeTypes.includes(file.type)) throw new Error('Tipe file belum diizinkan oleh kebijakan bukti.');
  const hashLimit = Number(listData.policy.sha256VerifyMaxBytes ?? 0);
  message(section, 'Menyiapkan upload privat...');
  const hash = file.size <= hashLimit ? await sha256(file) : null;
  const init = await invoke({
    action: 'INIT_UPLOAD', caseId, originalFilename: file.name, mimeType: file.type,
    fileSizeBytes: file.size, sha256Hash: hash, accessScope: scope,
  });
  let uploadResponseReadable = false;
  try {
    const uploaded = await fetch(init.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    uploadResponseReadable = uploaded.ok;
    if (!uploaded.ok) throw new Error('Upload ke repositori privat gagal. Coba kembali.');
  } catch (_) {
    // Google can accept the cross-origin upload while withholding the response from browser JavaScript.
    // COMPLETE_UPLOAD performs authoritative metadata and SHA-256 verification before registration.
  }
  try {
    await invoke({ action: 'COMPLETE_UPLOAD', caseId, sessionId: init.sessionId, description });
  } catch (error) {
    if (!uploadResponseReadable) throw new Error('Upload belum dapat diverifikasi oleh server. Muat ulang daftar sebelum mencoba kembali.');
    throw error;
  }
  message(section, 'Bukti tersimpan privat dan upload dicatat di audit trail.', 'success');
  fileInput.value = '';
  section.querySelector('.evidence-description').value = '';
  await render(true);
}

async function render(force = false) {
  if (rendering || !detail) return;
  const caseId = activeCaseId();
  if (!caseId || !detail.children.length) return;
  const existing = detail.querySelector('.evidence-workspace');
  if (!force && existing?.dataset.caseId === caseId) return;
  rendering = true;
  try {
    const data = await invoke({ action: 'LIST', caseId });
    policy = data.policy;
    detail.querySelector('.evidence-workspace')?.remove();
    const section = document.createElement('section');
    section.className = 'case-section evidence-workspace';
    section.dataset.caseId = caseId;
    section.innerHTML = `
      <div class="evidence-title"><div><h3>Evidence Management</h3><p class="muted">File privat, akses case-scoped, tanpa public link. Identitas pelapor tidak ditampilkan.</p></div><span class="status-badge">${data.evidence.length} file</span></div>
      <div class="evidence-message form-message" hidden></div>
      <div class="evidence-list"></div>
      ${data.canUpload ? `<div class="action-card evidence-upload"><h4>Tambah bukti</h4><input class="evidence-file" type="file" accept="${esc(data.policy.allowedMimeTypes.join(','))}"><textarea class="evidence-description" rows="2" maxlength="2000" placeholder="Catatan singkat bukti (jangan masukkan identitas pelapor)."></textarea><label>Scope awal<select class="evidence-scope"><option value="AUTHORITY_ONLY">Hanya otoritas case</option><option value="INVESTIGATION_TEAM">Tim Pemeriksa</option></select></label><button type="button" class="primary evidence-upload-button">Upload privat</button><small>Maksimum ${Math.round(data.policy.maxFileSizeBytes / 1048576)} MB. File tidak dibuat public atau anyone-with-link.</small></div>` : '<p class="muted">Case sudah ditutup; upload baru dinonaktifkan.</p>'}`;
    const items = section.querySelector('.evidence-list');
    if (!data.evidence.length) items.innerHTML = '<p class="empty-state">Belum ada file bukti pada case ini.</p>';
    else data.evidence.forEach((item) => items.append(evidenceCard(caseId, item, data.canReview, section)));
    section.querySelector('.evidence-upload-button')?.addEventListener('click', () => upload(caseId, section, data).catch((e) => message(section, e.message, 'error')));
    detail.append(section);
  } catch (_) {
    // Workspace utama tetap dapat dipakai bila evidence service belum tersedia.
  } finally {
    rendering = false;
  }
}

const observer = new MutationObserver(() => queueMicrotask(render));
if (detail) observer.observe(detail, { childList: true, subtree: true });
if (list) observer.observe(list, { attributes: true, childList: true, subtree: true, attributeFilter: ['class'] });
document.addEventListener('click', (event) => {
  if (event.target.closest?.('[data-case-id]')) setTimeout(render, 0);
});
setTimeout(render, 0);
