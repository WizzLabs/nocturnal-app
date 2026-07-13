// ─── ACCOUNT.JS (Sprint 8.3) ────────────────────────────────────────────────
// Handles the "Account" modal: permanent, irreversible account deletion.
// Reuses the same auth-token pattern as settings.js/personality.js (dynamic
// import of supabase-js so this file doesn't need to be a module).
//
// Does NOT touch script.js, chat/history/auth flows, or any other modal.

let accountAuthToken = null;
let accountSupabaseClient = null;

async function getAccountContext() {
  if (accountAuthToken && accountSupabaseClient) {
    return { token: accountAuthToken, supabase: accountSupabaseClient };
  }
  try {
    const res = await fetch('/api/config');
    const { supabaseUrl, supabaseAnonKey } = await res.json();
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    accountSupabaseClient = createClient(supabaseUrl, supabaseAnonKey);
    const { data: { session } } = await accountSupabaseClient.auth.getSession();
    accountAuthToken = session?.access_token || null;
    return { token: accountAuthToken, supabase: accountSupabaseClient };
  } catch (err) {
    console.error('Failed to get auth context for account deletion:', err);
    return { token: null, supabase: null };
  }
}

// ─── DOM REFS ───────────────────────────────────────────────────────────
const accountOpenBtn  = document.getElementById('account-btn');
const accountOverlayEl       = document.getElementById('account-overlay');
const accountCloseBtn = document.getElementById('account-close-btn');
const confirmInputEl  = document.getElementById('account-delete-confirm-input');
const deleteBtn       = document.getElementById('account-delete-btn');
const accountErrorEl  = document.getElementById('account-error');

const CONFIRM_PHRASE = 'DELETE';

function showModalError(msg) {
  if (!accountErrorEl) return;
  accountErrorEl.textContent = msg;
  accountErrorEl.style.display = 'block';
}
function clearModalError() {
  if (!accountErrorEl) return;
  accountErrorEl.style.display = 'none';
  accountErrorEl.textContent = '';
}

function openModal() {
  clearModalError();
  confirmInputEl.value = '';
  deleteBtn.disabled = true;
  deleteBtn.textContent = 'Delete Account';
  accountOverlayEl.classList.add('open');
}

function closeModal() {
  accountOverlayEl.classList.remove('open');
  confirmInputEl.value = '';
}

function updateDeleteButtonState() {
  deleteBtn.disabled = confirmInputEl.value.trim() !== CONFIRM_PHRASE;
}

async function deleteAccount() {
  if (confirmInputEl.value.trim() !== CONFIRM_PHRASE) return;

  clearModalError();
  deleteBtn.disabled = true;
  deleteBtn.textContent = 'Deleting…';

  try {
    const { token, supabase } = await getAccountContext();
    if (!token) {
      showModalError('Your session has expired. Please sign in again.');
      deleteBtn.textContent = 'Delete Account';
      updateDeleteButtonState();
      return;
    }

    const res = await fetch('/api/account', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to delete account.');

    // Account is gone server-side — clear the local session too, then
    // send the user to sign-in. No further requests from this page should
    // be treated as authenticated after this point.
    if (supabase) {
      try { await supabase.auth.signOut(); } catch { /* session is already invalid server-side */ }
    }
    window.location.replace('/auth.html');
  } catch (err) {
    showModalError(err.message || 'Failed to delete account. Please try again.');
    deleteBtn.textContent = 'Delete Account';
    updateDeleteButtonState();
    console.error('deleteAccount error:', err);
  }
}

// ─── LISTENERS ────────────────────────────────────────────────────────────
if (accountOpenBtn) accountOpenBtn.addEventListener('click', openModal);
if (accountCloseBtn) accountCloseBtn.addEventListener('click', closeModal);
if (accountOverlayEl) {
  accountOverlayEl.addEventListener('click', (e) => {
    if (e.target === accountOverlayEl) closeModal();
  });
}
if (confirmInputEl) confirmInputEl.addEventListener('input', updateDeleteButtonState);
if (deleteBtn) deleteBtn.addEventListener('click', deleteAccount);
