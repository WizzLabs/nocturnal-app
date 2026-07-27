// ─── STATE MANAGEMENT ────────────────────────────────
let currentSessionId = localStorage.getItem('current_session_id') || 'session_' + Date.now();
let attachedImageBase64 = null;
let attachedFile = null; // { name, type, data } — doc/image attachment, backed by the Document/Vision services
let chatHistory = [];
let isThinking = false;
let currentMode = "flash";
let controller = null;
let thinkingRow = null;
let currentRequestId = 0;


localStorage.setItem('current_session_id', currentSessionId);

// ─── AUTH TOKEN ───────────────────────────────────────
let cachedAuthToken = null;

async function initAuthToken() {
  try {
    const res = await fetch('/api/config');
    const { supabaseUrl, supabaseAnonKey } = await res.json();
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const supabase = createClient(supabaseUrl, supabaseAnonKey);
    const { data: { session } } = await supabase.auth.getSession();
    cachedAuthToken = session?.access_token || null;
    if (!cachedAuthToken) {
      window.location.replace('/auth.html');
    }
  } catch (err) {
    console.error('Failed to initialize auth token:', err);
  }
}

function authHeaders() {
  return cachedAuthToken ? { Authorization: `Bearer ${cachedAuthToken}` } : {};
}

// ─── DOM ELEMENTS ────────────────────────────────────
const messagesEl = document.getElementById('messages');
const inputEl    = document.getElementById('input');
const sendBtn    = document.getElementById('send-btn');

function getEmptyState() {
  return document.getElementById('empty-state');
}

const modeTabsWrap = document.getElementById('mode-tabs');

const shellEl           = document.getElementById('shell');
const sidebar           = document.getElementById('sidebar');
const menuToggleBtn      = document.getElementById("menu-toggle-btn");
const sidebarToggleBtn   = document.getElementById("sidebar-toggle-btn");
const sidebarBackdrop    = document.getElementById("sidebar-backdrop");
const newChatBtn         = document.getElementById('new-chat-btn');
const fileUploader       = document.getElementById('file-uploader');
const docUploader        = document.getElementById('doc-uploader');
const attachBtn          = document.getElementById('attach-btn');
const imagePreviewBox    = document.getElementById('image-preview-box');
const previewImg         = document.getElementById('preview-img');
const removeImgBtn       = document.getElementById('remove-img-btn');
const filePreviewBox     = document.getElementById('file-preview-box');
const previewFileName    = document.getElementById('preview-file-name');
const removeFileBtn      = document.getElementById('remove-file-btn');
const chatHistoryList    = document.getElementById('chat-history-list');
const historySearchInput = document.getElementById('search-chats');

// ─── VOICE (STT/TTS) DOM ELEMENTS ────────────────────
const micBtn              = document.getElementById('mic-btn');
const attachMenu           = document.getElementById('attach-menu');
const attachImageOption    = document.getElementById('attach-image-option');
const attachFileOption     = document.getElementById('attach-file-option');
const voiceStatusBar      = document.getElementById('voice-status-bar');
const voiceStatusText     = document.getElementById('voice-status-text');
const voiceStatusCancelBtn = document.getElementById('voice-status-cancel-btn');

// ─── SIDEBAR CHAT HISTORY & SEARCH ───────────────────
async function loadSidebarHistory() {
  if (!chatHistoryList) return;
  try {
    const res = await fetch(`/history/all`, { headers: authHeaders() });
    const data = await res.json();

    chatHistoryList.innerHTML = '';

    if (!data.sessions || data.sessions.length === 0) {
      chatHistoryList.innerHTML = '<div class="no-history">No past threads</div>';
      return;
    }

    data.sessions.forEach(session => {
      const item = document.createElement('div');
      item.classList.add('history-item');
      if (session.session_id === currentSessionId) item.classList.add('active');

      // Title text (static display)
      const textEl = document.createElement('span');
      textEl.classList.add('history-preview');
      textEl.textContent = session.preview;

      // Inline rename input (hidden by default)
      const renameInput = document.createElement('input');
      renameInput.classList.add('rename-input');
      renameInput.type = 'text';
      renameInput.value = session.preview.replace(/\.\.\.$/, '');
      renameInput.style.display = 'none';

      // Action buttons wrapper
      const actionsEl = document.createElement('div');
      actionsEl.classList.add('session-actions');

      const renameBtn = document.createElement('button');
      renameBtn.classList.add('rename-session-btn');
      renameBtn.title = 'Rename this chat';
      renameBtn.textContent = '✎';

      const deleteBtn = document.createElement('button');
      deleteBtn.classList.add('delete-session-btn');
      deleteBtn.title = 'Delete this chat';
      deleteBtn.textContent = '✕';

      actionsEl.appendChild(renameBtn);
      actionsEl.appendChild(deleteBtn);

      item.appendChild(textEl);
      item.appendChild(renameInput);
      item.appendChild(actionsEl);

      // ── Rename flow ──────────────────────────────────
      function enterRenameMode(e) {
        e.stopPropagation();
        textEl.style.display = 'none';
        actionsEl.style.display = 'none';
        renameInput.style.display = 'block';
        renameInput.focus();
        renameInput.select();
      }

      async function commitRename() {
        const newTitle = renameInput.value.trim();
        if (newTitle && newTitle !== session.preview.replace(/\.\.\.$/, '')) {
          try {
            await fetch(`/sessions/${session.session_id}/title`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', ...authHeaders() },
              body: JSON.stringify({ title: newTitle }),
            });
            await loadSidebarHistory();
            return;
          } catch (err) {
            console.error('Rename failed:', err);
          }
        }
        renameInput.style.display = 'none';
        textEl.style.display = '';
        actionsEl.style.display = '';
      }

      renameBtn.addEventListener('click', enterRenameMode);
      renameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
        if (e.key === 'Escape') {
          renameInput.style.display = 'none';
          textEl.style.display = '';
          actionsEl.style.display = '';
        }
      });
      renameInput.addEventListener('blur', commitRename);
      renameInput.addEventListener('click', (e) => e.stopPropagation());

      // ── Delete flow ──────────────────────────────────
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await deleteSession(session.session_id);
      });

      // ── Switch session on row click ──────────────────
      item.addEventListener('click', () => {
        if (renameInput.style.display === 'block') return;
        switchSession(session.session_id);
        if (isMobile()) closeMobileSidebar();
      });

      chatHistoryList.appendChild(item);
    });
  } catch (err) {
    console.error("Error updating history panel:", err);
  }
}

async function deleteSession(sessionId) {
  try {
    const res = await fetch(`/sessions/${sessionId}`, { method: 'DELETE', headers: authHeaders() });
    if (!res.ok) throw new Error('Delete failed');

    if (sessionId === currentSessionId) {
      startNewChat();
    }

    await loadSidebarHistory();
  } catch (err) {
    console.error("Failed to delete session:", err);
  }
}

async function switchSession(sessionId) {
  currentSessionId = sessionId;
  localStorage.setItem('current_session_id', currentSessionId);
  chatHistory = [];
  if (messagesEl) messagesEl.innerHTML = '';
  hideEmpty();

  try {
    const res = await fetch(`/sessions/${sessionId}`, { headers: authHeaders() });
    const data = await res.json();

    if (data.sessionLogs && data.sessionLogs.length > 0) {
      data.sessionLogs.forEach(log => {
        chatHistory.push({ role: 'user', content: log.user_message });
        appendMessage('user', log.user_message, false, log.attached_asset || null, log.created_at);
        chatHistory.push({ role: 'assistant', content: log.ai_response });
        appendMessage('ai', log.ai_response, false, null, log.created_at);
      });
    } else {
      renderEmptyState();
    }
  } catch (err) {
    console.error("Error switching conversation context:", err);
  }
  loadSidebarHistory();
}

// ─── SEARCH FILTER ────────────────────────────────────
if (historySearchInput) {
  historySearchInput.addEventListener('input', (e) => {
    const term = e.target.value.toLowerCase();
    const items = chatHistoryList.querySelectorAll('.history-item');
    items.forEach(item => {
      const text = item.textContent.toLowerCase();
      item.style.display = text.includes(term) ? 'flex' : 'none';
    });
  });
}

// ─── SIDEBAR TOGGLES ─────────────────────────────────
let sidebarCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';

function isMobile() { return window.innerWidth <= 768; }

function applySidebarState() {
  if (!shellEl) return;
  if (isMobile()) {
    shellEl.classList.remove('collapsed');
    if (sidebar) sidebar.classList.remove('mobile-open');
  } else {
    shellEl.classList.toggle('collapsed', sidebarCollapsed);
  }
}

function closeMobileSidebar() {
  if (sidebar) sidebar.classList.remove('mobile-open');
  if (sidebarBackdrop) sidebarBackdrop.classList.remove('visible');
}

function openMobileSidebar() {
  if (sidebar) sidebar.classList.add('mobile-open');
  if (sidebarBackdrop) sidebarBackdrop.classList.add('visible');
}

if (sidebarToggleBtn) {
  sidebarToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sidebarCollapsed = !sidebarCollapsed;
    localStorage.setItem('sidebar_collapsed', sidebarCollapsed);
    applySidebarState();
  });
}

if (menuToggleBtn) {
  menuToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (sidebar && sidebar.classList.contains('mobile-open')) {
      closeMobileSidebar();
    } else {
      openMobileSidebar();
    }
  });
}

if (sidebarBackdrop) {
  sidebarBackdrop.addEventListener('click', closeMobileSidebar);
}

applySidebarState();
window.addEventListener('resize', applySidebarState);

// ─── EMPTY STATE MARKUP ───────────────────────────────
const PROMPT_POOL = [
  "Refactor this function for readability, not just brevity",
  "Explain the tradeoffs before you pick an approach",
  "Rewrite this paragraph so it sounds like a person wrote it",
  "Find the bug, don't just patch the symptom",
  "Give me the blunt version of this feedback",
  "Turn these bullet points into a short brief",
  "What's the simplest way to test this?",
  "Poke holes in this plan before I commit to it",
  "Summarize this thread in three sentences",
  "Help me name this thing better",
  "What am I missing in this argument?",
  "Draft a reply that's firm but not rude",
  "Explain this like I'm reading it for the first time",
  "Compare these two options honestly",
  "Tighten this without losing the meaning",
];

function pickRandomPrompts(n = 4) {
  const pool = [...PROMPT_POOL];
  const picks = [];
  while (picks.length < n && pool.length) {
    const i = Math.floor(Math.random() * pool.length);
    picks.push(pool.splice(i, 1)[0]);
  }
  return picks;
}

function renderEmptyState() {
  if (!messagesEl) return;
  const prompts = pickRandomPrompts(4);
  const items = prompts.map((p, i) => `
        <button class="prompt-item" data-prompt="${p.replace(/"/g, '&quot;')}"><span class="prompt-index">${String(i + 1).padStart(2, '0')} —</span><span class="prompt-text">${p}</span></button>`).join('');
  messagesEl.innerHTML = `
    <div id="empty-state" class="empty-state">
      <div class="empty-heading">Start a session</div>
      <p class="empty-sub">Ask me anything. I'm here to help you think, create, and explore.</p>
      <div class="prompt-list" id="prompt-list">${items}
      </div>
      <div class="mode-guide" aria-label="AI mode overview">
        <span class="mode-guide-item"><b>Flash</b> — Fast responses</span>
        <span class="mode-guide-sep">/</span>
        <span class="mode-guide-item"><b>Insight</b> — Better reasoning</span>
        <span class="mode-guide-sep">/</span>
        <span class="mode-guide-item"><b>Abyss</b> — Deep thinking</span>
        <span class="mode-guide-sep">/</span>
        <span class="mode-guide-item"><b>Auto</b> — Chooses automatically</span>
      </div>
    </div>`;
}

// Event delegation so prompt buttons work even after messagesEl.innerHTML is replaced
if (messagesEl) {
  messagesEl.addEventListener('click', (e) => {
    const promptBtn = e.target.closest('.prompt-item');
    if (!promptBtn || !inputEl) return;
    inputEl.value = promptBtn.dataset.prompt || promptBtn.textContent.trim();
    autoResize();
    if (sendBtn) sendBtn.disabled = inputEl.value.trim() === '';
    inputEl.focus();
  });
}

// ─── NEW CHAT ─────────────────────────────────────────
function startNewChat() {
  chatHistory = [];
  currentSessionId = 'session_' + Date.now();
  localStorage.setItem('current_session_id', currentSessionId);
  renderEmptyState();
  clearImageAttachment();
}

if (newChatBtn) {
  newChatBtn.addEventListener('click', () => {
    startNewChat();
    loadSidebarHistory();
    if (isMobile()) closeMobileSidebar();
  });
}

// ─── IMAGE UPLOAD HANDLING ───────────────────────────
// attach-btn (three-dot icon) opens a small menu with "Upload Photo" and
// "Upload File" instead of going straight to the image picker.
// Sprint 6.5: switched from display:none/block toggling to a class-based
// 'open' state so both the open AND close motion can be animated in CSS
// (display swaps can't be transitioned).
function isAttachMenuOpen() { return !!(attachMenu && attachMenu.classList.contains('open')); }
function openAttachMenu() { if (attachMenu) attachMenu.classList.add('open'); }
function closeAttachMenu() { if (attachMenu) attachMenu.classList.remove('open'); }

if (attachBtn && attachMenu) {
  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isAttachMenuOpen()) closeAttachMenu(); else openAttachMenu();
  });
  document.addEventListener('click', (e) => {
    if (isAttachMenuOpen() && !attachMenu.contains(e.target) && e.target !== attachBtn) {
      closeAttachMenu();
    }
  });
}

if (attachImageOption) {
  attachImageOption.addEventListener('click', () => {
    closeAttachMenu();
    if (fileUploader) fileUploader.click();
  });
}

if (fileUploader) {
  fileUploader.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
      const img = new Image();
      img.src = event.target.result;
      img.onload = function() {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1024;
        let width = img.width;
        let height = img.height;

        if (width > MAX_WIDTH) {
          height *= MAX_WIDTH / width;
          width = MAX_WIDTH;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          attachedImageBase64 = canvas.toDataURL('image/jpeg', 0.92);
          if (previewImg) previewImg.src = attachedImageBase64;
          if (imagePreviewBox) imagePreviewBox.classList.add('show');
          if (attachBtn) attachBtn.classList.add('has-file');
        }
      };
    };
    reader.readAsDataURL(file);
  });
}

if (removeImgBtn) {
  removeImgBtn.addEventListener('click', clearImageAttachment);
}

function clearImageAttachment() {
  attachedImageBase64 = null;
  if (fileUploader) fileUploader.value = '';
  if (imagePreviewBox) imagePreviewBox.classList.remove('show');
  if (previewImg) previewImg.src = '';
  if (attachBtn && !attachedFile) attachBtn.classList.remove('has-file');
}

// ─── DOCUMENT UPLOAD HANDLING (Upload File) ──────────
// Sprint 6b: fully wired to the backend Document Service. PDF, DOCX, TXT,
// Markdown, and XLSX are parsed and answered from their actual content;
// images selected here (accept also allows image/*) are routed to the
// existing Vision pipeline server-side instead — see server.js.
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // mirrors server.js MAX_DOCUMENT_BYTES

if (attachFileOption) {
  attachFileOption.addEventListener('click', () => {
    closeAttachMenu();
    if (docUploader) docUploader.click();
  });
}

if (docUploader) {
  docUploader.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > MAX_DOCUMENT_BYTES) {
      appendMessage('ai', `"${file.name}" is too large (max ${MAX_DOCUMENT_BYTES / (1024 * 1024)}MB).`);
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      attachedFile = {
        name: file.name,
        type: file.type || 'application/octet-stream',
        data: event.target.result
      };
      if (previewFileName) previewFileName.textContent = file.name;
      if (filePreviewBox) filePreviewBox.classList.add('show');
      if (attachBtn) attachBtn.classList.add('has-file');
    };
    reader.readAsDataURL(file);
  });
}

if (removeFileBtn) {
  removeFileBtn.addEventListener('click', clearFileAttachment);
}

function clearFileAttachment() {
  attachedFile = null;
  if (docUploader) docUploader.value = '';
  if (filePreviewBox) filePreviewBox.classList.remove('show');
  if (previewFileName) previewFileName.textContent = '';
  if (attachBtn && !attachedImageBase64) attachBtn.classList.remove('has-file');
}

// ─── VOICE INPUT (STT) ────────────────────────────────
// Entirely browser-native via the Web Speech API (SpeechRecognition) — no
// backend involvement, no AI provider cost. Never calls sendMessage()
// itself — the user always presses Send manually.

const VOICE_STATES = { IDLE: 'idle', RECORDING: 'recording', READY: 'ready', ERROR: 'error' };

let voiceState = VOICE_STATES.IDLE;

function setVoiceState(state, message = '') {
  voiceState = state;
  if (!voiceStatusBar || !voiceStatusText) return;

  // Error or cancel: clear the status entirely and restore the normal
  // composer UI. No lingering banner — the message is still logged for
  // debugging, just not shown as an intrusive/sticky status.
  if (state === VOICE_STATES.IDLE || state === VOICE_STATES.ERROR) {
    if (state === VOICE_STATES.ERROR && message) console.error(message);
    voiceStatusBar.classList.remove('visible');
    voiceStatusBar.classList.remove('error');
    if (micBtn) { micBtn.classList.remove('recording'); micBtn.disabled = false; }
    voiceState = VOICE_STATES.IDLE;
    return;
  }

  let label = '';
  if (state === VOICE_STATES.RECORDING) {
    label = 'Listening…';
  } else if (state === VOICE_STATES.READY) {
    label = '✓ Transcript ready';
  }

  voiceStatusBar.classList.add('visible');
  voiceStatusBar.classList.remove('error');
  voiceStatusText.textContent = label;

  if (micBtn) micBtn.classList.toggle('recording', state === VOICE_STATES.RECORDING);

  // READY is terminal-but-visible; auto-clear after a moment.
  if (state === VOICE_STATES.READY) {
    setTimeout(() => { if (voiceState === state) setVoiceState(VOICE_STATES.IDLE); }, 2000);
  }
}

// ── Native browser Speech Recognition (only path) ──
function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

let nativeRecognition = null;
let nativeRecognizing = false;

function startNativeRecognition() {
  const SpeechRecognitionCtor = getSpeechRecognitionCtor();
  if (!SpeechRecognitionCtor || !inputEl) return false;

  nativeRecognition = new SpeechRecognitionCtor();
  nativeRecognition.lang = navigator.language || 'en-US';
  nativeRecognition.interimResults = true;
  nativeRecognition.continuous = true;

  const baseText = inputEl.value.trim();
  let finalTranscript = '';

  nativeRecognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalTranscript += chunk + ' ';
      else interim += chunk;
    }
    const combined = [baseText, (finalTranscript + interim).trim()].filter(Boolean).join(' ');
    inputEl.value = combined;
    autoResize();
    if (sendBtn) sendBtn.disabled = inputEl.value.trim() === '';
  };

  nativeRecognition.onerror = (event) => {
    console.error('Native speech recognition error:', event.error);
    nativeRecognizing = false;
    if (event.error !== 'aborted' && event.error !== 'no-speech') {
      setVoiceState(VOICE_STATES.ERROR, 'Voice recognition ran into an issue. Please try again.');
    } else {
      setVoiceState(VOICE_STATES.IDLE);
    }
  };

  nativeRecognition.onend = () => {
    nativeRecognizing = false;
    if (voiceState === VOICE_STATES.RECORDING) setVoiceState(VOICE_STATES.READY);
  };

  nativeRecognition.start();
  nativeRecognizing = true;
  setVoiceState(VOICE_STATES.RECORDING);
  return true;
}

function stopNativeRecognition() {
  if (nativeRecognition && nativeRecognizing) nativeRecognition.stop();
}

if (micBtn) {
  micBtn.addEventListener('click', () => {
    if (voiceState === VOICE_STATES.RECORDING) {
      if (nativeRecognizing) stopNativeRecognition();
      return;
    }
    if (voiceState === VOICE_STATES.IDLE || voiceState === VOICE_STATES.READY || voiceState === VOICE_STATES.ERROR) {
      if (getSpeechRecognitionCtor()) {
        startNativeRecognition();
      } else {
        setVoiceState(VOICE_STATES.ERROR, "Your browser doesn't support voice input.");
      }
    }
  });
}

if (voiceStatusCancelBtn) {
  voiceStatusCancelBtn.addEventListener('click', () => {
    if (voiceState === VOICE_STATES.RECORDING && nativeRecognizing) stopNativeRecognition();
    setVoiceState(VOICE_STATES.IDLE);
  });
}

// ─── VOICE OUTPUT (TTS) — browser SpeechSynthesis only ─
// No backend involvement: appendMessage() below attaches a "read aloud"
// button (SVG icon) to every AI row; clicking it speaks (or stops) that
// message's text.
let currentUtterance = null;

// Script-range checks are exact (Devanagari, Tamil, Japanese kana, etc.)
// The handful of Latin-script languages below (fr/de/es) use a cheap
// function-word heuristic — good enough to pick a closer voice than a
// hardcoded "always English" default, not meant to be a real detector.
// Falls back to 'en' whenever nothing matches confidently.
function detectResponseLanguage(text) {
  const sample = (text || '').slice(0, 500);
  if (!sample.trim()) return 'en';

  if (/[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/.test(sample)) return 'ja'; // hiragana/katakana
  if (/[\uac00-\ud7af]/.test(sample)) return 'ko';                          // hangul
  if (/[\u0e00-\u0e7f]/.test(sample)) return 'th';                          // thai
  if (/[\u0900-\u097f]/.test(sample)) return 'hi';                          // devanagari
  if (/[\u0b80-\u0bff]/.test(sample)) return 'ta';                          // tamil
  if (/[\u0600-\u06ff]/.test(sample)) return 'ar';                          // arabic
  if (/[\u0400-\u04ff]/.test(sample)) return 'ru';                          // cyrillic
  if (/[\u4e00-\u9fff]/.test(sample)) return 'zh';                          // han (no kana present)

  const lower = sample.toLowerCase();
  const scores = {
    fr: (lower.match(/\b(le|la|les|des|est|une|et|vous|nous|c'est|être|avec|bonjour)\b/g) || []).length,
    de: (lower.match(/\b(der|die|das|und|ist|nicht|ein|eine|mit|für|ich|sie)\b/g) || []).length,
    es: (lower.match(/\b(el|la|los|las|es|una|y|que|con|para|pero|hola)\b/g) || []).length,
  };
  const [bestLang, bestScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return bestScore >= 3 ? bestLang : 'en';
}

// Preferred region per detected language — used to look for an exact match
// first before falling back to "any voice starting with this language".
const LANGUAGE_REGION_MAP = {
  en: 'en-US', hi: 'hi-IN', ta: 'ta-IN', ja: 'ja-JP', fr: 'fr-FR',
  de: 'de-DE', es: 'es-ES', ar: 'ar-SA', ru: 'ru-RU', ko: 'ko-KR',
  zh: 'zh-CN', th: 'th-TH',
};

// Returns the closest available SpeechSynthesisVoice for a detected
// language, or null if the voice list isn't populated yet / nothing close
// exists — callers should treat null as "let the browser pick its default".
function pickVoiceForLanguage(langCode) {
  const voices = window.speechSynthesis.getVoices();
  if (!voices || !voices.length) return null;

  const preferredRegion = LANGUAGE_REGION_MAP[langCode];
  return (
    (preferredRegion && voices.find(v => v.lang === preferredRegion)) ||
    voices.find(v => v.lang && v.lang.toLowerCase().startsWith(langCode)) ||
    null
  );
}

function createTtsButton(text) {
  if (!('speechSynthesis' in window)) return null;
  const ttsBtn = document.createElement('button');
  ttsBtn.classList.add('tts-btn');
  ttsBtn.title = 'Read aloud';
  ttsBtn.innerHTML = `
    <svg class="tts-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M4 9.5v5h3.5L12.5 18V6L7.5 9.5H4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M16.5 9c1 1 1 5 0 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M18.8 7c2 2.2 2 7.8 0 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
  ttsBtn.addEventListener('click', () => speakText(text, ttsBtn));
  return ttsBtn;
}

function speakText(text, btn) {
  if (!('speechSynthesis' in window)) return;

  const isSpeakingThis = currentUtterance && btn.classList.contains('speaking');
  window.speechSynthesis.cancel(); // stop anything currently speaking

  // Only one message is ever "currently speaking" — clear every button's
  // state before (possibly) marking a new one, so cancelling one message
  // mid-speech can never leave a stale highlighted button behind.
  document.querySelectorAll('.tts-btn.speaking').forEach(b => b.classList.remove('speaking'));

  if (isSpeakingThis) {
    currentUtterance = null;
    return; // clicking again while speaking = stop only
  }

  const utterance = new SpeechSynthesisUtterance(text);

  // Detect the AI response's language (not the user's browser/UI language)
  // and pick the closest matching installed voice. Entirely client-side —
  // no backend call, no external API.
  const langCode = detectResponseLanguage(text);
  const voice = pickVoiceForLanguage(langCode);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    // No matching voice installed — set the lang hint anyway so the
    // browser's own default voice at least attempts correct pronunciation,
    // and gracefully fall back to its normal default otherwise.
    utterance.lang = LANGUAGE_REGION_MAP[langCode] || 'en-US';
  }

  utterance.onend = () => { btn.classList.remove('speaking'); currentUtterance = null; };
  utterance.onerror = () => { btn.classList.remove('speaking'); currentUtterance = null; };

  currentUtterance = utterance;
  btn.classList.add('speaking');
  window.speechSynthesis.speak(utterance);
}

// ─── MODE TABS ────────────────────────────────────────
if (modeTabsWrap) {
  const tabs = modeTabsWrap.querySelectorAll('.mode-tab');
  const indicator = document.getElementById('mode-tab-indicator');

  function moveIndicatorTo(tab) {
    if (!indicator || !tab) return;
    indicator.style.width = `${tab.offsetWidth}px`;
    indicator.style.transform = `translateX(${tab.offsetLeft}px)`;
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentMode = tab.dataset.value || 'flash';
      moveIndicatorTo(tab);
    });
  });

  // Position the indicator under whichever tab starts active, once layout
  // has settled (fonts/webfont swap can shift widths right after load).
  const placeInitialIndicator = () => {
    const active = modeTabsWrap.querySelector('.mode-tab.active') || tabs[0];
    moveIndicatorTo(active);
  };
  requestAnimationFrame(placeInitialIndicator);
  window.addEventListener('resize', placeInitialIndicator);
}

// ─── RENDER ENGINE & UTILITIES ───────────────────────
function getTime(date) {
  return (date ? new Date(date) : new Date()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollToBottom(smooth = true) {
  const wrap = document.getElementById('log-wrap');
  if (wrap) {
    wrap.scrollTo({
      top: wrap.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant'
    });
  }
}

function hideEmpty() {
  const es = getEmptyState();
  if (es) es.style.display = 'none';
}

function renderMarkdown(text) {
  const div = document.createElement('div');
  div.classList.add('md');
  const parts = text.split(/(```[\s\S]*?```)/g);

  parts.forEach(part => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const inner = part.slice(3, -3);
      const newline = inner.indexOf('\n');
      let lang = '';
      let code = inner;

      if (newline !== -1) {
        lang = inner.slice(0, newline).trim();
        code = inner.slice(newline + 1);
      }

      const copyBtn = document.createElement('button');
      copyBtn.classList.add('copy-btn');
      copyBtn.textContent = 'Copy';
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(code).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        });
      };

      const header = document.createElement('div');
      header.classList.add('code-header');
      if (lang) {
        const langLabel = document.createElement('span');
        langLabel.textContent = lang;
        header.appendChild(langLabel);
      }
      header.appendChild(copyBtn);

      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      if (lang) codeEl.classList.add(`lang-${lang}`);
      codeEl.textContent = code;
      pre.appendChild(codeEl);

      const wrapper = document.createElement('div');
      wrapper.classList.add('code-block');
      wrapper.appendChild(header);
      wrapper.appendChild(pre);
      div.appendChild(wrapper);
    } else {
      const lines = part.split('\n');
      lines.forEach((line, li) => {
        const trimmed = line.trim();
        if (trimmed === '') {
          if (li !== 0 && li !== lines.length - 1) {
            div.appendChild(document.createElement('br'));
          }
          return;
        }
        if (/^[A-Z][^a-z]*:$/.test(trimmed) || /^\d+\.\s+\*\*/.test(trimmed)) {
          const hLine = document.createElement('div');
          hLine.classList.add('md-heading');
          hLine.textContent = trimmed.replace(/\*\*/g, '').replace(/^\d+\.\s+/, '');
          div.appendChild(hLine);
          return;
        }
        if (/^[•\-\*]\s/.test(trimmed)) {
          const bullet = document.createElement('div');
          bullet.classList.add('md-bullet');
          renderInline(trimmed.replace(/^[•\-\*]\s/, ''), bullet);
          div.appendChild(bullet);
          return;
        }
        const p = document.createElement('div');
        p.classList.add('md-line');
        renderInline(trimmed, p);
        div.appendChild(p);
      });
    }
  });
  return div;
}

function renderInline(text, container) {
  text = text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
  const segments = text.split(/(`[^`]+`)/g);
  segments.forEach(seg => {
    if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
      const ic = document.createElement('code');
      ic.classList.add('inline-code');
      ic.textContent = seg.slice(1, -1);
      container.appendChild(ic);
    } else if (seg) {
      container.appendChild(document.createTextNode(seg));
    }
  });
}

function setStopMode(isStop) {
  if (!sendBtn) return;
  if (isStop) {
    sendBtn.disabled = false;
    sendBtn.textContent = "[ STOP ]";
    sendBtn.style.background = "#e0616b";
    sendBtn.style.color = "#0b0c0d";
    sendBtn.title = "Stop";
  } else {
    sendBtn.textContent = "[ SEND ]";
    sendBtn.style.background = "";
    sendBtn.style.color = "";
    sendBtn.title = "Send message";
  }
}

// role tag label, e.g. "YOU" / "NOCTURNAL_01"
function tagFor(role) {
  return role === 'ai' ? 'NOCTURNAL_01' : 'YOU';
}

// Sprint 8.2 — subtle "LIVE" badge shown above assistant messages that
// used live web search. Purely presentational, only rendered when the
// caller explicitly passes usedSearch === true.
function createLiveBadge() {
  const badge = document.createElement('div');
  badge.classList.add('live-badge');
  badge.innerHTML = `<span class="live-dot"></span>LIVE`;
  return badge;
}

// Sprint 8.2 — compact expandable "Sources" list below a search-grounded
// assistant message. Collapsed by default; clicking reveals article
// titles linking out to their original URLs. No-ops if there are no
// sources to show.
function createSourcesBlock(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;

  const wrap = document.createElement('div');
  wrap.classList.add('sources-wrap');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.classList.add('sources-btn');
  toggle.textContent = `Sources (${sources.length})`;

  const list = document.createElement('div');
  list.classList.add('sources-list');
  list.hidden = true;

  sources.forEach(src => {
    const link = document.createElement('a');
    link.classList.add('source-link');
    link.href = src.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = src.title || src.url;
    list.appendChild(link);
  });

  toggle.addEventListener('click', () => {
    list.hidden = !list.hidden;
    toggle.classList.toggle('open', !list.hidden);
  });

  wrap.appendChild(toggle);
  wrap.appendChild(list);
  return wrap;
}

function appendMessage(role, text, typing = false, imageDataUrl = null, sentAt = null, usedSearch = false, sources = []) {
  const row = document.createElement('div');
  row.classList.add('row', role === 'ai' ? 'ai' : 'user');
  if (typing) row.classList.add('thinking');

  const tag = document.createElement('div');
  tag.classList.add('row-tag');
  const tagLabel = document.createElement('span');
  tagLabel.textContent = tagFor(role);
  tag.appendChild(tagLabel);

  const content = document.createElement('div');
  content.classList.add('row-content');

  let statusLabelEl = null;
  if (typing) {
    const dots = document.createElement('div');
    dots.classList.add('dots');
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));
    content.appendChild(dots);
    statusLabelEl = document.createElement('span');
    statusLabelEl.classList.add('status-pulse');
    statusLabelEl.textContent = 'Thinking…';
    content.appendChild(statusLabelEl);
  } else if (role === 'ai' && text) {
    if (usedSearch) row.appendChild(createLiveBadge());
    content.appendChild(renderMarkdown(text));
    const ttsBtn = createTtsButton(text);
    if (ttsBtn) content.appendChild(ttsBtn);
    const sourcesBlock = createSourcesBlock(sources);
    if (sourcesBlock) content.appendChild(sourcesBlock);
  } else {
    if (imageDataUrl) {
      const imgWrap = document.createElement('div');
      imgWrap.classList.add('chat-image-wrap');
      const img = document.createElement('img');
      img.classList.add('chat-image');
      img.src = imageDataUrl;
      img.alt = 'Attached image';
      imgWrap.appendChild(img);
      content.appendChild(imgWrap);
    }
    if (text) {
      const textNode = document.createElement('div');
      textNode.classList.add('md-line');
      textNode.textContent = text;
      content.appendChild(textNode);
    }
  }

  row.appendChild(tag);
  row.appendChild(content);

  if (messagesEl) messagesEl.appendChild(row);
  scrollToBottom();
  return { row, bubble: content, statusLabel: statusLabelEl };
}

// ─── DYNAMIC STATUS ANIMATION (Sprint 6) ──────────────
// Driven entirely by real backend stage events over SSE (see
// readChatStream below) — no client-side timers or guessed sequences. The
// backend only ever sends stage keys it actually reached (Objective 2), so
// this is just a display-label lookup, never a simulation.
const STAGE_LABELS = {
  reading_image: 'Reading image…',
  reading_document: 'Reading document…',
  thinking: 'Thinking…',
  searching: 'Searching…',
  reasoning: 'Reasoning…',
  generating: 'Generating…',
};

function setStatus(labelEl, stage) {
  if (!labelEl) return;
  labelEl.textContent = STAGE_LABELS[stage] || stage;
  labelEl.classList.remove('status-swap');
  // Force reflow so the swap animation can re-trigger on repeated stages.
  void labelEl.offsetWidth;
  labelEl.classList.add('status-swap');
}

// Reads a fetch() Response body as an SSE stream of `data: {...}\n\n`
// frames and invokes onEvent(parsedObject) for each complete one as it
// arrives. Resolves once the stream ends. Malformed frames are skipped
// rather than throwing, so one bad chunk can't kill the whole response.
async function readChatStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      const line = frame.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(6)));
      } catch (e) {
        console.warn('Malformed SSE frame:', e);
      }
    }
  }
}

function typeText(bubble, text, requestId, speed = 14) {
  return new Promise(resolve => {
    bubble.textContent = '';
    bubble.classList.add('typing-cursor');
    let i = 0;

    function next() {
      if (requestId !== currentRequestId) {
        bubble.classList.remove('typing-cursor');
        return resolve();
      }
      if (i < text.length) {
        i++;
        if (i % 6 === 0 || i === text.length) {
          bubble.innerHTML = '';
          bubble.appendChild(renderMarkdown(text.slice(0, i)));
          scrollToBottom(false);
        }
        setTimeout(next, speed + Math.random() * 8);
      } else {
        bubble.classList.remove('typing-cursor');
        bubble.innerHTML = '';
        bubble.appendChild(renderMarkdown(text));
        scrollToBottom(false);
        resolve();
      }
    }
    next();
  });
}

// ─── SEND MESSAGE ─────────────────────────────────────
async function sendMessage() {
  if (!inputEl) return;
  const text = inputEl.value.trim();
  if (!text || isThinking) return;

  isThinking = true;
  const requestId = ++currentRequestId;

  if (sendBtn) sendBtn.disabled = true;
  hideEmpty();

  chatHistory.push({ role: 'user', content: text });
  const imageToSend = attachedImageBase64;
  const fileToSend = attachedFile;
  appendMessage('user', text, false, imageToSend);
  inputEl.value = '';
  autoResize();

  const { row, statusLabel } = appendMessage('ai', '', true);
  thinkingRow = row;

  try {
    controller = new AbortController();
    setStopMode(true);

    const res = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      signal: controller.signal,
      body: JSON.stringify({
        message: text,
        history: chatHistory,
        mode: currentMode,
        sessionId: currentSessionId,
        image: attachedImageBase64,
        file: fileToSend
      }),
    });

    if (requestId !== currentRequestId) return;
    if (res.status === 499 || !res.body) return;

    if (!res.ok) {
      // Non-streaming failure (e.g. validation error, 400) — the only case
      // that still responds as plain JSON, since it happens before the
      // SSE stream opens server-side (see server.js).
      let errMsg = 'Error connecting to server. Please try again.';
      try { const errData = await res.json(); if (errData?.error) errMsg = errData.error; } catch {}
      if (thinkingRow) { thinkingRow.remove(); thinkingRow = null; }
      appendMessage('ai', errMsg);
      return;
    }

    let finalPayload = null;
    let streamError = null;

    // Sprint 6 — Objective 1/3: every UI update from here on is driven by
    // real backend events, not client-side timing. Status text updates
    // live as `stage` events arrive; it's removed the instant the `final`
    // event lands (Objective 3: "remove status immediately when response
    // streaming begins").
    await readChatStream(res, (evt) => {
      if (requestId !== currentRequestId) return;
      if (evt.type === 'stage') {
        setStatus(statusLabel, evt.stage);
      } else if (evt.type === 'final') {
        finalPayload = evt;
      } else if (evt.type === 'error') {
        streamError = evt.error || 'Something went wrong. Please try again.';
      }
    });

    if (requestId !== currentRequestId) return;

    if (thinkingRow) { thinkingRow.remove(); thinkingRow = null; }

    if (streamError && !finalPayload) {
      appendMessage('ai', streamError);
      return;
    }
    if (!finalPayload) {
      appendMessage('ai', 'No response');
      return;
    }

    const reply = finalPayload.reply || "No response";
    const usedSearch = !!finalPayload.usedSearch;
    const sources = Array.isArray(finalPayload.sources) ? finalPayload.sources : [];

    const { row, bubble } = appendMessage('ai', '');
    if (usedSearch) row.insertBefore(createLiveBadge(), row.firstChild);
    chatHistory.push({ role: 'assistant', content: reply });

    await typeText(bubble, reply, requestId);
    const ttsBtn = createTtsButton(reply);
    if (ttsBtn) bubble.appendChild(ttsBtn);
    const sourcesBlock = createSourcesBlock(sources);
    if (sourcesBlock) bubble.appendChild(sourcesBlock);

  } catch (err) {
    if (err.name === "AbortError") return;
    if (requestId !== currentRequestId) return;
    console.error(err);
    if (thinkingRow) { thinkingRow.remove(); thinkingRow = null; }
    appendMessage('ai', 'Error connecting to server. Please try again.');
  }

  if (requestId === currentRequestId) {
    isThinking = false;
    controller = null;
    setStopMode(false);
    clearImageAttachment();
    clearFileAttachment();
    if (sendBtn) sendBtn.disabled = inputEl.value.trim() === '';
    loadSidebarHistory();
    inputEl.focus();
  }
}

function autoResize() {
  if (!inputEl) return;
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 140) + 'px';
}

if (inputEl) {
  inputEl.addEventListener('input', () => {
    autoResize();
    if (sendBtn) sendBtn.disabled = inputEl.value.trim() === '' || isThinking;
  });

  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

if (sendBtn) {
  sendBtn.onclick = () => {
    if (isThinking && controller) {
      ++currentRequestId;
      controller.abort();
      if (thinkingRow) { thinkingRow.remove(); thinkingRow = null; }
      appendMessage('ai', 'Request cancelled.');
      isThinking = false;
      controller = null;
      setStopMode(false);
      sendBtn.disabled = false;
      return;
    }
    sendMessage();
  };
}

// Initialize
if (inputEl) inputEl.focus();
renderEmptyState();
(async () => {
  await initAuthToken();
  loadSidebarHistory();
})();

// ─── LOGOUT LOGIC ────────────────────────────────────
const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    const originalText = logoutBtn.textContent;
    logoutBtn.textContent = '[ LOGGING OUT… ]';

    try {
      const res = await fetch('/api/config');
      const { supabaseUrl, supabaseAnonKey } = await res.json();

      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      const supabase = createClient(supabaseUrl, supabaseAnonKey);

      await supabase.auth.signOut();

      window.location.replace('/auth.html');
    } catch (e) {
      console.error('Logout error:', e);
      localStorage.removeItem('sb-pumnywxnpwgmurjqtdhr-auth-token');
      window.location.replace('/auth.html');
    }
  });
}

// ─── MODAL ACCESSIBILITY POLISH (Sprint 7.2) ───────────────────────────
// Escape closes whichever modal-overlay is currently open — applies
// uniformly to AI Settings, Personality, and Feedback without any of
// those files needing to know about each other.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const openOverlay = document.querySelector('.modal-overlay.open');
  if (openOverlay) openOverlay.classList.remove('open');
});
