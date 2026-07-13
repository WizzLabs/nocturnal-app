// ─── RESET-PASSWORD.JS (Sprint 8.3) ────────────────────────────────────────
// Handles the second half of the "Forgot Password" flow: the user arrives
// here from the link in their reset email. Supabase's client library
// automatically detects the recovery token in the URL (detectSessionInUrl
// defaults to true) and exchanges it for a temporary session — we just need
// to call supabase.auth.updateUser({ password }) once that session exists.
//
// Handles expired/invalid links gracefully (Supabase returns an error, or
// no session ever appears in the URL) by showing a clear message instead of
// a blank/broken form.
//
// Does NOT touch server.js, auth.js, auth.html, style.css, or script.js.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let supabase = null;

const titleEl       = document.getElementById('auth-title');
const subEl         = document.getElementById('auth-sub');
const formEl        = document.getElementById('auth-form');
const passwordEl    = document.getElementById('password');
const confirmEl     = document.getElementById('password-confirm');
const submitBtn     = document.getElementById('submit-btn');
const submitLabelEl = document.getElementById('submit-label');
const spinnerEl     = document.getElementById('btn-loader');
const errorEl       = document.getElementById('auth-error');
const successEl     = document.getElementById('auth-success');

function showError(msg) {
  errorEl.textContent     = msg;
  errorEl.style.display   = 'block';
  successEl.style.display = 'none';
}
function showSuccess(msg) {
  successEl.textContent   = msg;
  successEl.style.display = 'block';
  errorEl.style.display   = 'none';
}
function setLoading(loading) {
  submitBtn.disabled          = loading || !formFilled();
  submitLabelEl.style.display = loading ? 'none' : 'inline';
  spinnerEl.style.display     = loading ? 'flex' : 'none';
}
function formFilled() {
  return !!passwordEl.value && !!confirmEl.value;
}
function updateSubmitState() {
  submitBtn.disabled = !formFilled();
}
function disableForm(invalidLink) {
  formEl.style.display = 'none';
  titleEl.textContent = invalidLink ? 'Link expired' : 'Password updated';
}

async function init() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Config endpoint returned ' + res.status);
    const { supabaseUrl, supabaseAnonKey } = await res.json();
    supabase = createClient(supabaseUrl, supabaseAnonKey);
  } catch (err) {
    showError('Could not reach the server. Is it running on port 3000?');
    console.error('[reset-password] init error:', err);
    return;
  }

  // Give supabase-js a moment to parse the recovery token out of the URL
  // hash and establish a temporary session before we check for one.
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    // Either the link is malformed, already used, or expired. Supabase
    // also emits a PASSWORD_RECOVERY auth event right as the session is
    // set up — listen briefly in case getSession() ran just before that.
    const timeout = setTimeout(() => {
      showError('This password reset link is invalid or has expired. Please request a new one.');
      subEl.textContent = 'Request a new link from the sign-in page';
      disableForm(true);
    }, 2500);

    supabase.auth.onAuthStateChange((event, sess) => {
      if (event === 'PASSWORD_RECOVERY' && sess) {
        clearTimeout(timeout);
        setupListeners();
      }
    });
    return;
  }

  setupListeners();
}

async function handleSubmit(e) {
  e.preventDefault();

  const password = passwordEl.value;
  const confirm  = confirmEl.value;

  if (password.length < 6) {
    showError('Password must be at least 6 characters.');
    return;
  }
  if (password !== confirm) {
    showError('Passwords do not match.');
    return;
  }

  setLoading(true);
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;

    // Supabase revokes the recovery session's sibling refresh tokens on
    // password change, so any other signed-in device is logged out too.
    await supabase.auth.signOut();

    showSuccess('Your password has been updated. Redirecting to sign in…');
    disableForm(false);
    setTimeout(() => window.location.replace('/auth.html'), 1800);
  } catch (err) {
    const msg = (err && err.message) || 'Could not update your password. Please try again.';
    showError(msg.includes('session') ? 'This link has expired. Please request a new password reset.' : msg);
    setLoading(false);
  }
}

function setupListeners() {
  formEl.addEventListener('submit', handleSubmit);
  passwordEl.addEventListener('input', updateSubmitState);
  confirmEl.addEventListener('input', updateSubmitState);
}

init();
