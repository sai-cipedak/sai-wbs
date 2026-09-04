import { supabaseClient } from './supabase-client.js';

const ROLE_LINKS = {
  TRIAGE: ['Penelaahan', 'internal.html'],
  SECRETARIAT: ['Sekretariat', 'secretariat.html'],
  HSE: ['Perlindungan', 'hse.html'],
  GRIEVANCE_COORDINATOR: ['Pengaduan', 'grievance.html'],
  DEKOM: ['Dekom', 'dekom.html'],
  SYSTEM_ADMIN: ['Admin', 'admin-users.html'],
};

const HANDLER_PAGES = {
  'secretariat.html': { active: 'secretariat.html', followup: 'followup.html' },
  'followup.html': { active: 'secretariat.html', followup: 'followup.html' },
  'hse.html': { active: 'hse.html', followup: 'hse-followup.html' },
  'hse-followup.html': { active: 'hse.html', followup: 'hse-followup.html' },
  'grievance.html': { active: 'grievance.html', followup: 'grievance-followup.html' },
  'grievance-followup.html': { active: 'grievance.html', followup: 'grievance-followup.html' },
  'dekom.html': { active: 'dekom.html', followup: 'dekom-followup.html' },
  'dekom-followup.html': { active: 'dekom.html', followup: 'dekom-followup.html' },
};

const currentPage = location.pathname.split('/').pop() || 'index.html';
const uatSuffix = new URLSearchParams(location.search).get('uat') === '1' ? '?uat=1' : '';

function installAdjustmentStyles() {
  if (document.querySelector('link[data-portal-adjustments]')) return;
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = 'assets/css/portal-adjustments.css?v=20260904-1';
  style.dataset.portalAdjustments = '1';
  document.head.append(style);
}

function isPageActive(href) {
  if (currentPage === href) return true;
  const group = HANDLER_PAGES[currentPage];
  return Boolean(group && group.active === href);
}

function link(label, href, roleAware = false) {
  const node = document.createElement('a');
  node.textContent = label;
  node.href = roleAware ? `${href}${uatSuffix}` : href;
  node.className = 'portal-nav-link';
  if (isPageActive(href)) node.setAttribute('aria-current', 'page');
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

async function installNavigation(header, session) {
  const nav = document.createElement('nav');
  nav.className = 'portal-nav';
  nav.setAttribute('aria-label', 'Navigasi portal');
  nav.append(link('Beranda', 'index.html'), link('Lapor anonim', 'lapor-anonim.html'), link('Cek anonim', 'cek-laporan.html'));

  try {
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

function prepareLegacyAuth(session) {
  document.body.classList.add('portal-auth-managed');
  document.body.dataset.authState = session?.user ? 'authenticated' : 'anonymous';

  const loginPanel = document.querySelector('#loginPanel');
  if (loginPanel) {
    loginPanel.classList.add('portal-login-context');
    const copy = [...loginPanel.children].find((child) => child.tagName === 'P' && !child.classList.contains('eyebrow'));
    if (copy) {
      copy.textContent = session?.user
        ? 'Akun yang sedang aktif belum dapat membuka halaman ini. Periksa pesan akses di bawah.'
        : 'Gunakan tombol Masuk dengan Google di header untuk membuka halaman ini.';
    }
  }

  for (const selector of ['#userLabel', '#identityLabel', '#accountLabel']) {
    const label = document.querySelector(selector);
    if (!label) continue;
    const strip = label.closest('.identity-strip');
    if (strip && label.parentElement) label.parentElement.hidden = true;
    else label.hidden = true;
  }

  for (const strip of document.querySelectorAll('.identity-strip')) {
    const remainingAction = strip.querySelector('a, button:not(#logoutButton), input, select, textarea');
    if (remainingAction) strip.classList.add('portal-legacy-actions-only');
    else strip.hidden = true;
  }
}

function authError(account, message) {
  const status = account.querySelector('.portal-auth-status');
  if (!status) return;
  status.textContent = message;
  status.hidden = !message;
}

function installAccount(header, session) {
  const tools = document.createElement('div');
  tools.className = 'portal-header-tools';

  const pagePill = header.querySelector(':scope > .pill');
  if (pagePill) pagePill.remove();

  const account = document.createElement('div');
  account.className = 'portal-account';

  if (session?.user) {
    const email = session.user.email || 'Akun Google';
    const copy = document.createElement('div');
    copy.className = 'portal-account-copy';
    const identity = document.createElement('strong');
    identity.textContent = `Halo, ${email}`;

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'text-button portal-account-logout';
    logout.textContent = 'Keluar';
    logout.addEventListener('click', async () => {
      logout.disabled = true;
      authError(account, '');
      const { error } = await supabaseClient.auth.signOut();
      if (error) {
        logout.disabled = false;
        authError(account, 'Belum dapat keluar. Coba lagi.');
        return;
      }
      location.reload();
    });
    copy.append(identity, logout);

    const mobile = document.createElement('div');
    mobile.className = 'portal-account-mobile';
    const emailLink = document.createElement('a');
    emailLink.href = session.user.email ? `mailto:${session.user.email}` : '#';
    emailLink.textContent = email;
    const separator = document.createElement('span');
    separator.textContent = '|';
    const mobileLogout = logout.cloneNode(true);
    mobileLogout.addEventListener('click', () => logout.click());
    mobile.append(emailLink, separator, mobileLogout);

    account.append(copy, mobile);
  } else {
    const login = document.createElement('button');
    login.type = 'button';
    login.className = 'primary small portal-auth-button';
    login.textContent = 'Masuk dengan Google';
    login.addEventListener('click', async () => {
      login.disabled = true;
      authError(account, '');
      const redirectTo = location.href.split('#')[0];
      const { error } = await supabaseClient.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
      if (error) {
        login.disabled = false;
        authError(account, error.message || 'Login belum dapat dimulai.');
      }
    });
    account.append(login);
  }

  const status = document.createElement('span');
  status.className = 'portal-auth-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  account.append(status);
  tools.append(account);
  header.append(tools);
}

function normalizeHandlerMenu() {
  const config = HANDLER_PAGES[currentPage];
  if (!config) return;
  const row = document.querySelector('.internal-toolbar .action-row');
  if (!row) return;

  row.classList.add('case-handler-nav');
  row.replaceChildren();

  const activeCases = document.createElement('a');
  activeCases.className = 'button secondary';
  activeCases.href = `${config.active}${uatSuffix}`;
  activeCases.textContent = 'Daftar Kasus Aktif';
  if (currentPage === config.active) activeCases.classList.add('case-handler-active');

  const followup = document.createElement('a');
  followup.id = 'followupLink';
  followup.className = 'button secondary';
  followup.href = `${config.followup}${uatSuffix}`;
  followup.textContent = 'Follow Up Pasca Penutupan';
  if (currentPage === config.followup) followup.classList.add('case-handler-active');

  const refresh = document.createElement('button');
  refresh.id = 'refreshButton';
  refresh.type = 'button';
  refresh.className = 'secondary';
  refresh.textContent = 'Muat Ulang';

  row.append(activeCases, followup, refresh);
}

installAdjustmentStyles();
normalizeHandlerMenu();

const header = document.querySelector('header .header-inner');
if (header) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  installBrand(header);
  prepareLegacyAuth(session);
  installAccount(header, session);
  await installNavigation(header, session);
}
