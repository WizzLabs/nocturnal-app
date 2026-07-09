// ─── SETTINGS.JS (Sprint 4 — BYOK) ─────────────────────────────────────────
// Handles the "AI Settings" modal: lets an authenticated user save/remove a
// personal API key + model, which server.js then prefers over the server
// defaults on /chat. Reuses the same auth-token pattern as script.js
// (dynamic import of supabase-js so this file doesn't need to be a module).
//
// Does NOT touch script.js, does NOT touch chat/history/auth flows.

let settingsAuthToken = null;

async function getSettingsAuthToken() {
  if (settingsAuthToken) return settingsAuthToken;
  try {
    const res = await fetch('/api/config');
    const { supabaseUrl, supabaseAnonKey } = await res.json();
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const supabase = createClient(supabaseUrl, supabaseAnonKey);
    const { data: { session } } = await supabase.auth.getSession();
    settingsAuthToken = session?.access_token || null;
    return settingsAuthToken;
  } catch (err) {
    console.error('Failed to get auth token for settings:', err);
    return null;
  }
}

async function settingsAuthHeaders() {
  const token = await getSettingsAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ─── DOM REFS ───────────────────────────────────────────────────────────
const overlayEl     = document.getElementById('ai-settings-overlay');
const openBtn        = document.getElementById('ai-settings-btn');
const closeBtn        = document.getElementById('ai-settings-close-btn');
const statusEl        = document.getElementById('ai-settings-status');
const apiKeyInput     = document.getElementById('ai-settings-api-key');
const modelInput      = document.getElementById('ai-settings-model');
const errorEl         = document.getElementById('ai-settings-error');
const saveBtn         = document.getElementById('ai-settings-save-btn');
const removeBtn       = document.getElementById('ai-settings-remove-btn');

function showModalError(msg) {
  errorEl.textContent = msg;
  errorEl.style.display = 'block';
}
function clearModalError() {
  errorEl.style.display = 'none';
  errorEl.textContent = '';
}

async function loadSettingsStatus() {
  statusEl.textContent = 'Loading…';
  try {
    const res = await fetch('/api/ai-settings', { headers: await settingsAuthHeaders() });
    if (!res.ok) throw new Error('Failed to load status');
    const data = await res.json();
    if (data.hasSettings) {
      statusEl.textContent = `Personal configuration active — model: ${data.model}`;
      modelInput.value = data.model || '';
    } else {
      statusEl.textContent = 'Using server default configuration.';
      modelInput.value = '';
    }
    // API key field is never pre-filled — the server never returns it.
    apiKeyInput.value = '';
  } catch (err) {
    statusEl.textContent = '';
    showModalError('Could not load current settings status.');
    console.error('loadSettingsStatus error:', err);
  }
}

function openModal() {
  clearModalError();
  overlayEl.style.display = 'flex';
  loadSettingsStatus();
}

function closeModal() {
  overlayEl.style.display = 'none';
  apiKeyInput.value = '';
}

async function saveSettings() {
  clearModalError();
  const apiKey = apiKeyInput.value.trim();
  const model = modelInput.value.trim();

  if (!apiKey || !model) {
    showModalError('Both API key and model are required to save.');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/ai-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await settingsAuthHeaders()) },
      body: JSON.stringify({ apiKey, model }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save settings.');
    await loadSettingsStatus();
  } catch (err) {
    showModalError(err.message || 'Failed to save settings.');
    console.error('saveSettings error:', err);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

async function removeSettings() {
  clearModalError();
  removeBtn.disabled = true;
  removeBtn.textContent = 'Removing…';
  try {
    const res = await fetch('/api/ai-settings', {
      method: 'DELETE',
      headers: await settingsAuthHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to remove settings.');
    await loadSettingsStatus();
  } catch (err) {
    showModalError(err.message || 'Failed to remove settings.');
    console.error('removeSettings error:', err);
  } finally {
    removeBtn.disabled = false;
    removeBtn.textContent = 'Remove Personal Configuration';
  }
}

// ─── LISTENERS ────────────────────────────────────────────────────────────
if (openBtn) openBtn.addEventListener('click', openModal);
if (closeBtn) closeBtn.addEventListener('click', closeModal);
if (overlayEl) {
  overlayEl.addEventListener('click', (e) => {
    if (e.target === overlayEl) closeModal(); // click outside modal box
  });
}
if (saveBtn) saveBtn.addEventListener('click', saveSettings);
if (removeBtn) removeBtn.addEventListener('click', removeSettings);
