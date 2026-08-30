import { supabaseClient } from './supabase-client.js';

const isUat = new URLSearchParams(location.search).get('uat') === '1';

if (isUat) {
  const originalInvoke = supabaseClient.functions.invoke.bind(supabaseClient.functions);
  supabaseClient.functions.invoke = (functionName, options = {}) => {
    if (functionName === 'secretariat-team-action') {
      return originalInvoke(functionName, {
        ...options,
        body: { ...(options.body ?? {}), uat: true },
      });
    }
    return originalInvoke(functionName, options);
  };

  const originalSignIn = supabaseClient.auth.signInWithOAuth.bind(supabaseClient.auth);
  supabaseClient.auth.signInWithOAuth = (options = {}) => {
    const next = { ...options, options: { ...(options.options ?? {}) } };
    if (next.options.redirectTo) {
      const redirect = new URL(next.options.redirectTo, location.href);
      redirect.searchParams.set('uat', '1');
      next.options.redirectTo = redirect.href;
    }
    return originalSignIn(next);
  };

  const banner = document.createElement('div');
  banner.className = 'form-message internal-message';
  banner.style.margin = '16px auto';
  banner.style.maxWidth = '1200px';
  banner.textContent = 'Mode UAT aktif — data test Sekretariat ditampilkan. Mode ini hanya dapat digunakan oleh SYSTEM_ADMIN aktif.';
  document.querySelector('main')?.prepend(banner);
}
