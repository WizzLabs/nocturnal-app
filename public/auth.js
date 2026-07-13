// ─── AUTH.JS ──────────────────────────────────────────────────────────────
// Handles Sign In / Sign Up / Forgot Password using Supabase Auth.
//
// Flow:
//   1. Fetch /api/config to get supabaseUrl + supabaseAnonKey.
//   2. Create a browser-side Supabase client (anon key only — service key is
//      never sent to the browser).
//   3. If a valid session already exists → redirect straight to the main app.
//   4. Otherwise set up the form for Sign In, Sign Up, or Forgot Password.
//
// Sprint 8.3: adds the "check your email" confirmation screen, a
// "resend verification email" action, a "Forgot password?" flow, and
// friendlier error/loading/success states throughout.
//
// This file is loaded as an ES module so we can import from the Supabase CDN.
// It does NOT touch server.js, style.css, index.html, or script.js.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── STATE ────────────────────────────────────────────────────────────────
let supabase = null;
// mode: 'signin' | 'signup' | 'forgot'
let mode = 'signin';
let pendingVerificationEmail = null; // set after a sign-up that needs confirmation

// ─── DOM REFS ─────────────────────────────────────────────────────────────
const titleEl        = document.getElementById('auth-title');
const subEl          = document.getElementById('auth-sub');
const formEl         = document.getElementById('auth-form');
const emailEl        = document.getElementById('email');
const passwordEl     = document.getElementById('password');
const passwordGroupEl = document.getElementById('password-group');
const submitBtn      = document.getElementById('submit-btn');
const submitLabelEl  = document.getElementById('submit-label');
const spinnerEl      = document.getElementById('btn-loader');
const errorEl        = document.getElementById('auth-error');
const successEl      = document.getElementById('auth-success');
const toggleLinkEl   = document.getElementById('toggle-link');
const toggleTextEl   = document.getElementById('toggle-text');
const forgotLinkEl   = document.getElementById('forgot-link');
const resendWrapEl   = document.getElementById('resend-wrap');
const resendLinkEl   = document.getElementById('resend-link');

// ─── INIT ─────────────────────────────────────────────────────────────────
async function init() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Config endpoint returned ' + res.status);
    const { supabaseUrl, supabaseAnonKey } = await res.json();

    if (!supabaseUrl || !supabaseAnonKey) {
      showError('Server configuration is incomplete. Contact the administrator.');
      return;
    }

    supabase = createClient(supabaseUrl, supabaseAnonKey);

    // ── If a valid session already exists, skip the auth page ──────────
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      window.location.replace('/');
      return;
    }
  } catch (err) {
    showError('Could not reach the server. Is it running on port 3000?');
    console.error('[auth] init error:', err);
    return;
  }

  setupListeners();
}

// ─── MODE: SIGN IN / SIGN UP / FORGOT PASSWORD ────────────────────────────
function setMode(nextMode) {
  mode = nextMode;
  clearMessages();
  passwordEl.value = '';
  resendWrapEl.style.display = 'none';
  formEl.style.display = 'flex';
  toggleLinkEl.parentElement.style.display = 'flex';

  if (mode === 'signup') {
    titleEl.textContent       = 'Create account';
    subEl.textContent         = 'Your AI companion awaits';
    submitLabelEl.textContent = 'Sign up';
    toggleTextEl.textContent  = 'Already have an account?';
    toggleLinkEl.textContent  = 'Sign in';
    forgotLinkEl.style.display = 'none';
    passwordGroupEl.style.display = 'flex';
    passwordEl.setAttribute('autocomplete', 'new-password');
  } else if (mode === 'forgot') {
    titleEl.textContent       = 'Reset your password';
    subEl.textContent         = "We'll email you a reset link";
    submitLabelEl.textContent = 'Send reset link';
    toggleTextEl.textContent  = 'Remembered your password?';
    toggleLinkEl.textContent  = 'Sign in';
    forgotLinkEl.style.display = 'none';
    passwordGroupEl.style.display = 'none';
  } else {
    titleEl.textContent       = 'Sign in to Nocturnal';
    subEl.textContent         = 'Your AI companion awaits';
    submitLabelEl.textContent = 'Sign in';
    toggleTextEl.textContent  = "Don't have an account?";
    toggleLinkEl.textContent  = 'Sign up';
    forgotLinkEl.style.display = 'inline';
    passwordGroupEl.style.display = 'flex';
    passwordEl.setAttribute('autocomplete', 'current-password');
  }

  updateSubmitState();
}

// ─── FEEDBACK HELPERS ─────────────────────────────────────────────────────
function showError(msg) {
  errorEl.textContent     = msg;
  errorEl.style.display   = 'block';
  successEl.style.display = 'none';
}

function showSuccess(msg) {
  successEl.textContent  = msg;
  successEl.style.display = 'block';
  errorEl.style.display   = 'none';
}

function clearMessages() {
  errorEl.style.display   = 'none';
  successEl.style.display = 'none';
}

// ─── LOADING STATE ────────────────────────────────────────────────────────
function setLoading(loading) {
  submitBtn.disabled          = loading || !isFormFilled();
  submitLabelEl.style.display = loading ? 'none'  : 'inline';
  spinnerEl.style.display     = loading ? 'flex'  : 'none';
}

function isFormFilled() {
  if (mode === 'forgot') return !!emailEl.value.trim();
  return !!emailEl.value.trim() && !!passwordEl.value;
}

function updateSubmitState() {
  submitBtn.disabled = !isFormFilled();
}

// ─── FRIENDLY ERROR MAPPING ────────────────────────────────────────────────
function friendlyMessage(err) {
  const msg = (err && err.message) || 'Something went wrong. Please try again.';
  if (msg.includes('Invalid login credentials')) return 'Incorrect email or password.';
  if (msg.includes('Email not confirmed')) return 'Please verify your email before signing in.';
  if (msg.includes('User already registered')) return 'An account with this email already exists. Try signing in instead.';
  if (msg.includes('Password should be at least')) return 'Password must be at least 6 characters.';
  if (msg.toLowerCase().includes('rate limit')) return 'Too many attempts. Please wait a moment and try again.';
  if (msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch')) return 'Network error. Check your connection and try again.';
  return msg;
}

// ─── FORM SUBMIT ──────────────────────────────────────────────────────────
async function handleSubmit(e) {
  e.preventDefault();

  const email    = emailEl.value.trim();
  const password = passwordEl.value;

  if (!email) {
    showError('Please enter your email address.');
    return;
  }
  if (mode !== 'forgot' && !password) {
    showError('Please enter your password.');
    return;
  }
  if (mode === 'signup' && password.length < 6) {
    showError('Password must be at least 6 characters.');
    return;
  }

  setLoading(true);
  clearMessages();

  try {
    if (mode === 'signup') {
      await handleSignUp(email, password);
    } else if (mode === 'forgot') {
      await handleForgotPassword(email);
    } else {
      await handleSignIn(email, password);
    }
  } catch (err) {
    showError(friendlyMessage(err));
    if (err && err.message && err.message.includes('Email not confirmed')) {
      pendingVerificationEmail = email;
      resendWrapEl.style.display = 'block';
    }
    setLoading(false);
  }
}

async function handleSignUp(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin + '/auth.html' },
  });
  if (error) throw error;

  if (data.session) {
    // Email confirmation is disabled in this Supabase project → logged in immediately
    window.location.replace('/');
    return;
  }

  // Email confirmation is required → clean "check your email" screen
  pendingVerificationEmail = email;
  showCheckEmailScreen(email);
  setLoading(false);
}

async function handleSignIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  window.location.replace('/');
}

async function handleForgotPassword(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + '/reset-password.html',
  });
  if (error) throw error;

  showSuccess('If an account exists for that email, a password reset link is on its way. Check your inbox.');
  setLoading(false);
}

// ─── "CHECK YOUR EMAIL" SCREEN (post sign-up) ──────────────────────────────
function showCheckEmailScreen(email) {
  formEl.style.display = 'none';
  toggleLinkEl.parentElement.style.display = 'none';
  titleEl.textContent = 'Check your email';
  subEl.textContent = `We sent a confirmation link to ${email}`;
  showSuccess('Click the link in that email to activate your account, then come back and sign in.');
  resendWrapEl.style.display = 'block';
}

// ─── RESEND VERIFICATION EMAIL ──────────────────────────────────────────────
async function handleResend() {
  const email = pendingVerificationEmail || emailEl.value.trim();
  if (!email) {
    showError('Enter your email above first, then resend.');
    return;
  }

  resendLinkEl.textContent = 'Sending…';
  resendLinkEl.style.pointerEvents = 'none';
  try {
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: window.location.origin + '/auth.html' },
    });
    if (error) throw error;
    showSuccess(`Verification email resent to ${email}.`);
  } catch (err) {
    showError(friendlyMessage(err));
  } finally {
    resendLinkEl.textContent = 'Resend verification email';
    resendLinkEl.style.pointerEvents = 'auto';
  }
}

// ─── LISTENERS ────────────────────────────────────────────────────────────
function setupListeners() {
  formEl.addEventListener('submit', handleSubmit);

  toggleLinkEl.addEventListener('click', () => {
    setMode(mode === 'signin' ? 'signup' : 'signin');
  });

  forgotLinkEl.addEventListener('click', (e) => {
    e.preventDefault();
    setMode('forgot');
  });

  resendLinkEl.addEventListener('click', (e) => {
    e.preventDefault();
    handleResend();
  });

  emailEl.addEventListener('input', updateSubmitState);
  passwordEl.addEventListener('input', updateSubmitState);

  setMode('signin');
}

// ─── BOOT ─────────────────────────────────────────────────────────────────
init();
