import { supabaseClient } from './supabase-client.js';

const HANDOFF_MESSAGES = {
  ROUTE_INTEGRITY: 'Laporan berhasil diklasifikasikan sebagai Pelanggaran Integritas dan dirujuk ke Sekretariat DS. Status berikutnya: Menunggu Pembentukan Tim.',
  ROUTE_SAFEGUARDING: 'Laporan berhasil dirujuk ke Cluster Lead HSE untuk penanganan Keselamatan & Perlindungan Anak.',
  ROUTE_GRIEVANCE: 'Laporan berhasil dirujuk ke penanganan Keluhan / Pengaduan Layanan.',
  ROUTE_DEKOM: 'Laporan berhasil dialihkan ke kewenangan Dekom.',
};

const originalInvoke = supabaseClient.functions.invoke.bind(supabaseClient.functions);
supabaseClient.functions.invoke = async (functionName, options = {}) => {
  const response = await originalInvoke(functionName, options);
  const action = options?.body?.action;
  const message = functionName === 'triage-case-action' ? HANDOFF_MESSAGES[action] : null;
  if (message && !response.error) {
    const apply = () => {
      const node = document.querySelector('#pageMessage');
      if (!node) return;
      node.textContent = message;
      node.className = 'form-message internal-message success';
      node.hidden = false;
    };
    // loadCases() removes the routed case from TRIAGE immediately. Re-apply the
    // handoff confirmation after that refresh so the successful transition is visible.
    setTimeout(apply, 500);
    setTimeout(apply, 1500);
  }
  return response;
};
