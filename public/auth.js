// ─── AUTH.JS ──────────────────────────────────────────────────────────────
// Handles Sign In / Sign Up using Supabase Auth.
//
// Flow:
//   1. Fetch /api/config to get supabaseUrl + supabaseAnonKey.
//   2. Create a browser-side Supabase client (anon key only — service key is
//      never sent to the browser).
//   3. If a valid session already exists → redirect straight to the main app.
//   4. Otherwise set up the form for Sign In or Sign Up.
//
// This file is loaded as an ES module so we can import from the Supabase CDN.
// It does NOT touch server.js, style.css, index.html, or script.js.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── STATE ────────────────────────────────────────────────────────────────
let supabase = null;
let isSignUp = false;

// ─── DOM REFS ─────────────────────────────────────────────────────────────
const titleEl       = document.getElementById('auth-title');
const formEl        = document.getElementById('auth-form');
const emailEl       = document.getElementById('email');
const passwordEl    = document.getElementById('password');
const submitBtn     = document.getElementById('submit-btn');
const submitLabelEl = document.getElementById('submit-label');
const spinnerEl     = document.getElementById('btn-loader');
const errorEl       = document.getElementById('auth-error');
const successEl     = document.getElementById('auth-success');
const toggleLinkEl  = document.getElementById('toggle-link');
const toggleTextEl  = document.getElementById('toggle-text');

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

// ─── MODE: SIGN IN / SIGN UP ──────────────────────────────────────────────
function setMode(signUp) {
  isSignUp = signUp;
  titleEl.textContent       = signUp ? 'Create account'          : 'Sign in to Nocturnal';
  submitLabelEl.textContent = signUp ? 'Sign up'                 : 'Sign in';
  toggleTextEl.textContent  = signUp ? 'Already have an account?': "Don't have an account?";
  toggleLinkEl.textContent  = signUp ? 'Sign in'                 : 'Sign up';
  clearMessages();
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
  submitBtn.disabled          = loading;
  submitLabelEl.style.display = loading ? 'none'  : 'inline';
  spinnerEl.style.display     = loading ? 'flex'  : 'none';
}

// ─── FORM SUBMIT ──────────────────────────────────────────────────────────
async function handleSubmit(e) {
  e.preventDefault();

  const email    = emailEl.value.trim();
  const password = passwordEl.value;

  if (!email || !password) {
    showError('Please enter your email and password.');
    return;
  }
  if (isSignUp && password.length < 6) {
    showError('Password must be at least 6 characters.');
    return;
  }

  setLoading(true);
  clearMessages();

  try {
    if (isSignUp) {
      // ── SIGN UP ─────────────────────────────────────────────────────
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;

      if (data.session) {
        // Email confirmation is disabled in Supabase → logged in immediately
        window.location.replace('/');
      } else {
        // Email confirmation is enabled → ask the user to check inbox
        showSuccess(
          'Account created! Check your inbox and confirm your email, then sign in.'
        );
        setMode(false);   // switch to sign-in form
        setLoading(false);
      }
    } else {
      // ── SIGN IN ─────────────────────────────────────────────────────
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      window.location.replace('/');
    }
  } catch (err) {
    // Map Supabase error messages to friendlier text
    let msg = err.message || 'Something went wrong. Please try again.';
    if (msg.includes('Invalid login credentials'))  msg = 'Incorrect email or password.';
    if (msg.includes('Email not confirmed'))        msg = 'Please confirm your email before signing in.';
    if (msg.includes('User already registered'))   msg = 'An account with this email already exists. Sign in instead.';
    showError(msg);
    setLoading(false);
  }
}

// ─── LISTENERS ────────────────────────────────────────────────────────────
function setupListeners() {
  formEl.addEventListener('submit', handleSubmit);
  toggleLinkEl.addEventListener('click', () => setMode(!isSignUp));

  // Only enable submit when both fields have content
  function updateSubmitState() {
    submitBtn.disabled = !emailEl.value.trim() || !passwordEl.value;
  }
  emailEl.addEventListener('input', updateSubmitState);
  passwordEl.addEventListener('input', updateSubmitState);
}

// ─── BOOT ─────────────────────────────────────────────────────────────────
init();
