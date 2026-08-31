import { supabaseClient } from './supabase-client.js';

const HANDOFF = {
  ROUTE_INTEGRITY: {
    destination: 'Sekretariat DS',
    detail: 'Laporan diklasifikasikan sebagai Pelanggaran Integritas. Status berikutnya: Menunggu Pembentukan Tim.',
  },
  ROUTE_SAFEGUARDING: {
    destination: 'Cluster Lead HSE',
    detail: 'Laporan diteruskan untuk penanganan Keselamatan & Perlindungan Anak.',
  },
  ROUTE_GRIEVANCE: {
    destination: 'Koordinator Pengaduan Layanan',
    detail: 'Laporan diteruskan untuk penanganan Keluhan / Pengaduan Layanan.',
  },
  ROUTE_DEKOM: {
    destination: 'Dekom',
    detail: 'Laporan dialihkan ke kewenangan Dekom.',
  },
};

function ensurePopupStyles() {
  if (document.querySelector('#triage-routing-popup-style')) return;
  const style = document.createElement('style');
  style.id = 'triage-routing-popup-style';
  style.textContent = `
    .triage-routing-dialog {
      width: min(520px, calc(100vw - 32px));
      border: 0;
      border-radius: 18px;
      padding: 0;
      background: #fff;
      color: #1d2733;
      box-shadow: 0 24px 70px rgba(16, 24, 40, .24);
    }
    .triage-routing-dialog::backdrop {
      background: rgba(16, 24, 40, .52);
      backdrop-filter: blur(2px);
    }
    .triage-routing-dialog__body { padding: 26px; }
    .triage-routing-dialog__icon {
      width: 42px;
      height: 42px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      margin-bottom: 16px;
      background: #f0fdf4;
      color: #166534;
      font-size: 22px;
      font-weight: 800;
    }
    .triage-routing-dialog h2 { margin: 0 0 10px; font-size: 22px; }
    .triage-routing-dialog p { margin: 0; line-height: 1.6; }
    .triage-routing-dialog .muted-copy { margin-top: 8px; color: #667085; font-size: 14px; }
    .triage-routing-dialog__actions { display: flex; justify-content: flex-end; margin-top: 22px; }
  `;
  document.head.append(style);
}

function showRoutingPopup(caseNumber, handoff) {
  if (!handoff) return;
  ensurePopupStyles();

  const message = `Proses routing case ${caseNumber} berhasil diteruskan ke ${handoff.destination}.`;
  const dialog = document.createElement('dialog');
  dialog.className = 'triage-routing-dialog';

  const body = document.createElement('div');
  body.className = 'triage-routing-dialog__body';

  const icon = document.createElement('div');
  icon.className = 'triage-routing-dialog__icon';
  icon.textContent = '✓';

  const title = document.createElement('h2');
  title.textContent = 'Routing berhasil';

  const copy = document.createElement('p');
  copy.textContent = message;

  const detail = document.createElement('p');
  detail.className = 'muted-copy';
  detail.textContent = handoff.detail;

  const actions = document.createElement('div');
  actions.className = 'triage-routing-dialog__actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'primary';
  close.textContent = 'Oke';
  close.addEventListener('click', () => dialog.close());
  actions.append(close);

  body.append(icon, title, copy, detail, actions);
  dialog.append(body);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.append(dialog);

  if (typeof dialog.showModal === 'function') dialog.showModal();
  else {
    alert(`${message}\n\n${handoff.detail}`);
    dialog.remove();
  }
}

const originalInvoke = supabaseClient.functions.invoke.bind(supabaseClient.functions);
supabaseClient.functions.invoke = async (functionName, options = {}) => {
  const response = await originalInvoke(functionName, options);
  const action = options?.body?.action;
  const handoff = functionName === 'triage-case-action' ? HANDOFF[action] : null;

  if (handoff && !response.error) {
    const caseNumber = response.data?.nomorLaporan || '—';
    const message = `Proses routing case ${caseNumber} berhasil diteruskan ke ${handoff.destination}.`;

    const applyInlineMessage = () => {
      const node = document.querySelector('#pageMessage');
      if (!node) return;
      node.textContent = `${message} ${handoff.detail}`;
      node.className = 'form-message internal-message success';
      node.hidden = false;
    };

    showRoutingPopup(caseNumber, handoff);
    setTimeout(applyInlineMessage, 500);
    setTimeout(applyInlineMessage, 1500);
  }

  return response;
};
