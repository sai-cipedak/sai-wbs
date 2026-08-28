import { supabaseClient } from './supabase-client.js';

const EXPECTED_CASE_ID = '51af1597-4b5f-4e24-8ca4-fab73adda5ea';
const EXPECTED_PUBLIC_ID = 'SAI-CIP-26-4FRALM2DPX';
const loginPanel = document.querySelector('#loginPanel');
const workspacePanel = document.querySelector('#workspacePanel');
const loginMessage = document.querySelector('#loginMessage');
const caseList = document.querySelector('#caseList');
const caseDetail = document.querySelector('#caseDetail');
const requested = new URLSearchParams(location.search).get('case');

async function authorize() {
  if (requested !== EXPECTED_PUBLIC_ID) {
    loginPanel.hidden = false;
    loginMessage.textContent = 'Case UAT tidak valid.';
    loginMessage.className = 'form-message error';
    loginMessage.hidden = false;
    return;
  }
  const session = (await supabaseClient.auth.getSession()).data.session;
  if (!session?.user) {
    loginPanel.hidden = false;
    workspacePanel.hidden = true;
    return;
  }
  loginPanel.hidden = true;
  workspacePanel.hidden = false;
  document.querySelector('#userLabel').textContent = session.user.email || 'Akun internal';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'case-list-button active';
  button.dataset.caseId = EXPECTED_CASE_ID;
  const number = document.createElement('strong');
  number.textContent = EXPECTED_PUBLIC_ID;
  const label = document.createElement('span');
  label.textContent = 'UAT_EVIDENCE_MANAGEMENT';
  button.append(number, label);
  caseList.replaceChildren(button);

  const head = document.createElement('section');
  head.className = 'case-section';
  const title = document.createElement('h2');
  title.textContent = 'TEST - UAT Evidence Management';
  const copy = document.createElement('p');
  copy.className = 'muted';
  copy.textContent = 'Pelapor: Identitas Dirahasiakan · Case synthetic UAT';
  head.append(title, copy);
  caseDetail.replaceChildren(head);
  await import('./evidence-workspace.js?v=20260828-2');
}

document.querySelector('#googleLogin')?.addEventListener('click', async () => {
  const redirectTo = new URL(`evidence-uat.html?case=${encodeURIComponent(EXPECTED_PUBLIC_ID)}`, location.href).href;
  const { error } = await supabaseClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  if (error) {
    loginMessage.textContent = error.message;
    loginMessage.className = 'form-message error';
    loginMessage.hidden = false;
  }
});
document.querySelector('#logoutButton')?.addEventListener('click', async () => {
  await supabaseClient.auth.signOut();
  location.reload();
});

await authorize();
supabaseClient.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') location.reload();
  else if (event === 'SIGNED_IN' && workspacePanel.hidden) authorize();
});
