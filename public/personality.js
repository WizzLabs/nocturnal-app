// ─── PERSONALITY.JS (Sprint 7) ─────────────────────────────────────────────
// Handles the "Personality" modal: lets an authenticated user pick a response
// style preset (Professional/Casual/Creative/Technical) plus optional custom
// instructions. server.js loads these server-side by req.userId on every
// /chat call — this file only ever writes preferences, it never influences
// a request directly. Reuses the same auth-token pattern as settings.js.
//
// Does NOT touch script.js, does NOT touch chat/history/auth flows, and does
// NOT touch the AI Settings modal (BYOK stays fully separate).

let personalityAuthToken = null;

async function getPersonalityAuthToken() {
  if (personalityAuthToken) return personalityAuthToken;
  try {
    const res = await fetch('/api/config');
    const { supabaseUrl, supabaseAnonKey } = await res.json();
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const supabase = createClient(supabaseUrl, supabaseAnonKey);
    const { data: { session } } = await supabase.auth.getSession();
    personalityAuthToken = session?.access_token || null;
    return personalityAuthToken;
  } catch (err) {
    console.error('Failed to get auth token for personality settings:', err);
    return null;
  }
}

async function personalityAuthHeaders() {
  const token = await getPersonalityAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── DOM REFS ───────────────────────────────────────────────────────────
const personalityOverlayEl  = document.getElementById('personality-overlay');
const personalityOpenBtn    = document.getElementById('personality-btn');
const personalityCloseBtn   = document.getElementById('personality-close-btn');
const personalityStatusEl   = document.getElementById('personality-status');
const presetGridEl          = document.getElementById('personality-preset-grid');
const customInstructionsEl  = document.getElementById('personality-custom-instructions');
const personalityErrorEl    = document.getElementById('personality-error');
const personalitySaveBtn    = document.getElementById('personality-save-btn');
const personalityClearBtn   = document.getElementById('personality-clear-btn');

let selectedPreset = null; // one active preset at a time, or null

function showPersonalityError(msg) {
  personalityErrorEl.textContent = msg;
  personalityErrorEl.style.display = 'block';
}
function clearPersonalityError() {
  personalityErrorEl.style.display = 'none';
  personalityErrorEl.textContent = '';
}

// Single source of truth for the status line — used on load, on preset
// click, and on reset, so it's always in sync with `selectedPreset` without
// waiting on a network round trip.
function formatStatusText(preset) {
  if (!preset) return "Using Nocturnal's default style.";
  return `Using ${preset.charAt(0).toUpperCase() + preset.slice(1)} style.`;
}

// Swaps the status text with a subtle fade rather than an instant jump —
// fades out, swaps the text while invisible, then fades back in. Guards
// against overlapping transitions if the preset is clicked again quickly.
let statusFadeTimeout = null;
function setStatusText(text) {
  if (statusFadeTimeout) clearTimeout(statusFadeTimeout);
  personalityStatusEl.classList.add('fading');
  statusFadeTimeout = setTimeout(() => {
    personalityStatusEl.textContent = text;
    personalityStatusEl.classList.remove('fading');
    statusFadeTimeout = null;
  }, 150);
}

function setSelectedPreset(preset) {
  selectedPreset = preset;
  if (presetGridEl) {
    presetGridEl.querySelectorAll('.preset-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.preset === preset);
    });
  }
  setStatusText(formatStatusText(preset));
}

async function loadPersonalityStatus() {
  personalityStatusEl.textContent = 'Loading…';
  try {
    const res = await fetch('/api/personality', { headers: await personalityAuthHeaders() });
    if (!res.ok) throw new Error('Failed to load personality settings');
    const data = await res.json();

    setSelectedPreset(data.preset || null);
    customInstructionsEl.value = data.customInstructions || '';
    // setSelectedPreset() above already set the status text correctly —
    // no separate branch needed here, which also removes the risk of the
    // two status strings drifting out of sync with each other.
  } catch (err) {
    personalityStatusEl.textContent = '';
    showPersonalityError('Could not load current personality settings.');
    console.error('loadPersonalityStatus error:', err);
  }
}

function openPersonalityModal() {
  clearPersonalityError();
  personalityOverlayEl.classList.add('open');
  loadPersonalityStatus();
}

function closePersonalityModal() {
  personalityOverlayEl.classList.remove('open');
}

async function savePersonality() {
  clearPersonalityError();
  const customInstructions = customInstructionsEl.value.trim();

  if (customInstructions.length > 800) {
    showPersonalityError('Custom instructions must be under 800 characters.');
    return;
  }

  personalitySaveBtn.disabled = true;
  personalitySaveBtn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/personality', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await personalityAuthHeaders()) },
      body: JSON.stringify({ preset: selectedPreset, customInstructions }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save personality settings.');
    await loadPersonalityStatus();
  } catch (err) {
    showPersonalityError(err.message || 'Failed to save personality settings.');
    console.error('savePersonality error:', err);
  } finally {
    personalitySaveBtn.disabled = false;
    personalitySaveBtn.textContent = 'Save';
  }
}

async function clearPersonality() {
  clearPersonalityError();
  personalityClearBtn.disabled = true;
  personalityClearBtn.textContent = 'Resetting…';
  try {
    const res = await fetch('/api/personality', {
      method: 'DELETE',
      headers: await personalityAuthHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to reset personality settings.');
    setSelectedPreset(null);
    customInstructionsEl.value = '';
    await loadPersonalityStatus();
  } catch (err) {
    showPersonalityError(err.message || 'Failed to reset personality settings.');
    console.error('clearPersonality error:', err);
  } finally {
    personalityClearBtn.disabled = false;
    personalityClearBtn.textContent = 'Reset to Default';
  }
}

// ─── LISTENERS ────────────────────────────────────────────────────────────
if (personalityOpenBtn) personalityOpenBtn.addEventListener('click', openPersonalityModal);
if (personalityCloseBtn) personalityCloseBtn.addEventListener('click', closePersonalityModal);
if (personalityOverlayEl) {
  personalityOverlayEl.addEventListener('click', (e) => {
    if (e.target === personalityOverlayEl) closePersonalityModal(); // click outside modal box
  });
}
if (presetGridEl) {
  presetGridEl.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Toggle off if clicking the already-active preset, otherwise select it —
      // only one preset can be active at a time.
      setSelectedPreset(selectedPreset === btn.dataset.preset ? null : btn.dataset.preset);
    });
  });
}
if (personalitySaveBtn) personalitySaveBtn.addEventListener('click', savePersonality);
if (personalityClearBtn) personalityClearBtn.addEventListener('click', clearPersonality);
