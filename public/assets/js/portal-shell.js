import { supabaseClient } from './supabase-client.js';

const ROLE_LINKS = {
  TRIAGE: ['Penelaahan', 'internal.html'],
  SECRETARIAT: ['Sekretariat', 'secretariat.html'],
  HSE: ['Perlindungan', 'hse.html'],
  GRIEVANCE_COORDINATOR: ['Pengaduan', 'grievance.html'],
  DEKOM: ['Dekom', 'dekom.html'],
  SYSTEM_ADMIN: ['Admin', 'admin-users.html'],
};

const currentPage = location.pathname.split('/').pop() || 'index.html';
const uatSuffix = new URLSearchParams(location.search).get('uat') === '1' ? '?uat=1' : '';

function link(label, href, roleAware = false) {
  const node = document.createElement('a');
  node.textContent = label;
  node.href = roleAware ? `${href}${uatSuffix}` : href;
  node.className = 'portal-nav-link';
  if (currentPage === href) node.setAttribute('aria-current', 'page');
  return node;
}

function installBrand(header) {
  const existing = header.querySelector('.brand');
  if (!existing) return;
  const brand = existing instanceof HTMLAnchorElement ? existing : document.createElement('a');
  brand.className = 'brand portal-brand';
  brand.href = 'index.html';
  brand.setAttribute('aria-label', 'Layanan Aduan Komunitas SAI - Beranda');
  brand.replaceChildren();
  const logo = document.createElement('img');
  logo.src = 'assets/img/laduni-sai.png';
  logo.alt = '';
  logo.width = 44;
  logo.height = 44;
  const words = document.createElement('span');
  words.innerHTML = '<strong>Laduni SAI</strong><small>Layanan Aduan Komunitas SAI</small>';
  brand.append(logo, words);
  if (brand !== existing) existing.replaceWith(brand);
}

function activeRole(row, now) {
  return new Date(row.active_from).getTime() <= now
    && (!row.active_until || now < new Date(row.active_until).getTime());
}

async function installNavigation(header) {
  const nav = document.createElement('nav');
  nav.className = 'portal-nav';
  nav.setAttribute('aria-label', 'Navigasi portal');
  nav.append(link('Beranda', 'index.html'), link('Lapor anonim', 'lapor-anonim.html'), link('Cek anonim', 'cek-laporan.html'));

  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session?.user) {
      nav.append(link('Laporan Saya', 'my-reports.html'));
      header.append(nav);
      return;
    }

    nav.append(link('Laporan Saya', 'my-reports.html'));
    const nowIso = new Date().toISOString();
    const [{ data: roleRows }, { count: assignmentCount }] = await Promise.all([
      supabaseClient.from('user_system_roles')
        .select('role_code,active_from,active_until')
        .eq('user_id', session.user.id)
        .lte('active_from', nowIso),
      supabaseClient.from('case_assignments')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', session.user.id)
        .eq('access_status', 'ACTIVE'),
    ]);
    const now = Date.now();
    const roles = new Set((roleRows ?? []).filter((row) => activeRole(row, now)).map((row) => row.role_code));
    for (const [code, [label, href]] of Object.entries(ROLE_LINKS)) {
      if (roles.has(code)) nav.append(link(label, href, true));
    }
    if ((assignmentCount ?? 0) > 0) nav.append(link('Tim Pemeriksa', 'investigation.html', true));
  } catch (error) {
    console.warn('Navigasi role belum dapat dimuat.', error);
  }
  header.append(nav);
}

const header = document.querySelector('header .header-inner');
if (header) {
  installBrand(header);
  await installNavigation(header);
}

