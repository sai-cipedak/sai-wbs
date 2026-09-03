import { invokePublic } from './supabase-client.js';

const stats = document.querySelector('#publicStats');
const message = document.querySelector('#statsMessage');

function setValue(name, value) {
  const node = stats?.querySelector(`[data-stat="${name}"]`);
  if (node) node.textContent = new Intl.NumberFormat('id-ID').format(Number(value ?? 0));
}

try {
  const data = await invokePublic('public-case-stats', {});
  for (const key of ['total', 'received', 'review', 'handling', 'closed']) setValue(key, data[key]);
  if (message) {
    message.textContent = 'Statistik agregat laporan production. Data UAT dan detail laporan tidak disertakan.';
    message.hidden = false;
  }
} catch (error) {
  if (stats) stats.hidden = true;
  console.warn('Statistik portal belum dapat dimuat.', error);
}

