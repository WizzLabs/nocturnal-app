// ─── STATE MANAGEMENT ────────────────────────────────
let currentSessionId = localStorage.getItem('current_session_id') || 'session_' + Date.now();
let attachedImageBase64 = null; 
let chatHistory = [];
let isThinking = false;
let currentMode = "flash";
let controller = null;
let thinkingRow = null;
let currentRequestId = 0;

localStorage.setItem('current_session_id', currentSessionId);

// ─── AUTH TOKEN (Sprint 2: per-user isolation) ───────
// Cached once on page load so every fetch() to a protected route can attach
// it. Dynamic import used (same pattern as the existing logout block below)
// so this file doesn't need to become an ES module.
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
      // No valid session — bounce to auth page rather than let requests 401 silently
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

// FIX: emptyState is referenced by ID each time it's needed (not cached once at startup),
// because newChatBtn replaces the innerHTML of messagesEl which destroys the old node.
function getEmptyState() {
  return document.getElementById('empty-state');
}

const modeDropdown = document.querySelector(".mode-dropdown");
const modeSelected = document.querySelector(".mode-selected");
const modeOptions  = document.querySelector(".mode-options");

const sidebar          = document.getElementById('sidebar');
const menuToggleBtn    = document.getElementById("menu-toggle-btn");   // mobile header btn
const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn"); // desktop collapse btn
const sidebarBackdrop  = document.getElementById("sidebar-backdrop");
const newChatBtn       = document.getElementById('new-chat-btn');
const fileUploader     = document.getElementById('file-uploader');
const attachBtn        = document.getElementById('attach-btn');
const imagePreviewBox  = document.getElementById('image-preview-box');
const previewImg       = document.getElementById('preview-img');
const removeImgBtn     = document.getElementById('remove-img-btn');
const chatHistoryList  = document.getElementById('chat-history-list');

// FIX: was querying '#search-histories' but HTML uses id="search-chats"
const historySearchInput = document.getElementById('search-chats');

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

      // Chat icon
      const iconEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      iconEl.setAttribute('width', '14');
      iconEl.setAttribute('height', '14');
      iconEl.setAttribute('viewBox', '0 0 24 24');
      iconEl.setAttribute('fill', 'none');
      iconEl.setAttribute('stroke', 'currentColor');
      iconEl.setAttribute('stroke-width', '2');
      iconEl.style.flexShrink = '0';
      iconEl.style.opacity = '0.6';
      iconEl.innerHTML = '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>';

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

      // Rename button
      const renameBtn = document.createElement('button');
      renameBtn.classList.add('rename-session-btn');
      renameBtn.title = 'Rename this chat';
      renameBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.classList.add('delete-session-btn');
      deleteBtn.title = 'Delete this chat';
      deleteBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4h6v2"></path></svg>`;

      actionsEl.appendChild(renameBtn);
      actionsEl.appendChild(deleteBtn);

      item.appendChild(iconEl);
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

// FIX: Delete session — calls DELETE endpoint, then clears UI if it was active
async function deleteSession(sessionId) {
  try {
    const res = await fetch(`/sessions/${sessionId}`, { method: 'DELETE', headers: authHeaders() });
    if (!res.ok) throw new Error('Delete failed');

    // If we just deleted the active session, start a fresh chat
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
        appendMessage('user', log.user_message, false, log.attached_asset || null);
        chatHistory.push({ role: 'assistant', content: log.ai_response });
        appendMessage('ai', log.ai_response);
      });
    } else {
      const es = getEmptyState();
      if (es) es.style.display = 'flex';
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
// Persist collapsed state across page loads
let sidebarCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';

function isMobile() { return window.innerWidth <= 768; }

function applySidebarState() {
  if (!sidebar) return;
  if (isMobile()) {
    // Mobile: use overlay pattern — collapsed class means nothing here
    sidebar.classList.remove('collapsed');
  } else {
    // Desktop: toggle collapsed icon-rail
    sidebar.classList.toggle('collapsed', sidebarCollapsed);
  }
}

function closeMobileSidebar() {
  sidebar.classList.remove('mobile-open');
  if (sidebarBackdrop) sidebarBackdrop.classList.remove('visible');
}

function openMobileSidebar() {
  sidebar.classList.add('mobile-open');
  if (sidebarBackdrop) sidebarBackdrop.classList.add('visible');
}

// Desktop toggle btn (lives inside sidebar)
if (sidebarToggleBtn && sidebar) {
  sidebarToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isMobile()) {
      closeMobileSidebar();
    } else {
      sidebarCollapsed = !sidebarCollapsed;
      localStorage.setItem('sidebar_collapsed', sidebarCollapsed);
      applySidebarState();
    }
  });
}

// Mobile header hamburger btn
if (menuToggleBtn && sidebar) {
  menuToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMobileSidebar();
  });
}

// Backdrop click closes mobile sidebar
if (sidebarBackdrop) {
  sidebarBackdrop.addEventListener('click', closeMobileSidebar);
}

// Apply initial state
applySidebarState();
window.addEventListener('resize', applySidebarState);

// ─── NEW CHAT ─────────────────────────────────────────
function startNewChat() {
  chatHistory = [];
  currentSessionId = 'session_' + Date.now();
  localStorage.setItem('current_session_id', currentSessionId);
  if (messagesEl) {
    messagesEl.innerHTML = `
      <div id="empty-state">
        <div class="void-logo">
          <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;">
            <path stroke="#00FF66" stroke-width="2.2" stroke-linecap="round" d="M35,8 C10,22 18,42 48,49"/>
            <path stroke="#00FF66" stroke-width="2.2" stroke-linecap="round" d="M65,8 C90,22 82,42 52,49"/>
            <path stroke="#00FF66" stroke-width="2.2" stroke-linecap="round" d="M35,92 C10,78 18,58 48,51"/>
            <path stroke="#00FF66" stroke-width="2.2" stroke-linecap="round" d="M65,92 C90,78 82,58 52,51"/>
            <path stroke="#00FF66" stroke-width="1.6" stroke-linecap="round" opacity="0.65" d="M8,38 C22,10 42,18 49,48"/>
            <path stroke="#00FF66" stroke-width="1.6" stroke-linecap="round" opacity="0.65" d="M8,62 C22,90 42,82 49,52"/>
            <path stroke="#00FF66" stroke-width="1.6" stroke-linecap="round" opacity="0.65" d="M92,38 C78,10 58,18 51,48"/>
            <path stroke="#00FF66" stroke-width="1.6" stroke-linecap="round" opacity="0.65" d="M92,62 C78,90 58,82 51,52"/>
            <circle cx="50" cy="50" r="38" stroke="#00FF66" stroke-width="0.5" opacity="0.12"/>
            <circle cx="50" cy="50" r="24" stroke="#00FF66" stroke-width="0.4" opacity="0.09"/>
            <circle cx="50" cy="50" r="3" fill="#00FF66"/>
          </svg>
        </div>
        <h2>Hello, I'm Nocturnal</h2>
        <p>Ask me anything. I'm here to help you think, create, and explore.</p>
      </div>`;
  }
  // FIX: re-query after innerHTML replacement so we get the fresh node
  const es = getEmptyState();
  if (es) es.style.display = 'flex';
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
if (attachBtn) {
  attachBtn.addEventListener('click', () => {
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
          // FIX: Use higher quality (0.92) for better model readability
          attachedImageBase64 = canvas.toDataURL('image/jpeg', 0.92);
          if (previewImg) previewImg.src = attachedImageBase64;
          if (imagePreviewBox) imagePreviewBox.style.display = 'block';
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
  if (imagePreviewBox) imagePreviewBox.style.display = 'none';
  if (previewImg) previewImg.src = '';
  if (attachBtn) attachBtn.classList.remove('has-file');
}

// ─── MODE DROPDOWN ────────────────────────────────────
if (modeSelected) {
  modeSelected.addEventListener("click", () => {
    if (modeOptions) modeOptions.classList.toggle("show");
  });
}

if (modeOptions) {
  modeOptions.querySelectorAll("div").forEach(opt => {
    opt.addEventListener("click", () => {
      modeOptions.querySelectorAll("div").forEach(o => o.classList.remove("active"));
      opt.classList.add("active");
      currentMode = opt.dataset.value || "flash";
      if (modeSelected) modeSelected.textContent = opt.textContent;
      modeOptions.classList.remove("show");
    });
  });
  const defaultFlash = modeOptions.querySelector('[data-value="flash"]');
  if (defaultFlash) defaultFlash.classList.add("active");
}

document.addEventListener("click", (e) => {
  if (modeDropdown && !modeDropdown.contains(e.target)) {
    if (modeOptions) modeOptions.classList.remove("show");
  }
});

// ─── RENDER ENGINE & UTILITIES ───────────────────────
function getTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollToBottom(smooth = true) {
  if (messagesEl) {
    messagesEl.scrollTo({
      top: messagesEl.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant'
    });
  }
}

function hideEmpty() {
  // FIX: re-query live each time so we always get the current DOM node
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
          hLine.textContent = trimmed.replace(/\*\ Third*/g, '').replace(/^\d+\.\s+/, '');
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
    sendBtn.innerHTML = "⏹";
    sendBtn.style.background = "#ff4d4d";
    sendBtn.title = "Stop";
  } else {
    sendBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="white">
        <path d="M14 8L2 2L5.5 8L2 14L14 8Z"/>
      </svg>`;
    sendBtn.style.background = "";
    sendBtn.title = "Send message";
  }
}

function appendMessage(role, text, typing = false, imageDataUrl = null) {
  const row = document.createElement('div');
  row.classList.add('msg-row', role);
  if (typing) row.classList.add('thinking');

  const inner = document.createElement('div');
  inner.classList.add('msg-inner');

  const bubble = document.createElement('div');
  bubble.classList.add('bubble');

  if (typing) {
    const dots = document.createElement('div');
    dots.classList.add('dots');
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));
    bubble.appendChild(dots);
    const label = document.createElement('span');
    label.textContent = 'Nocturnal is thinking';
    bubble.appendChild(label);
  } else if (role === 'ai' && text) {
    bubble.appendChild(renderMarkdown(text));
  } else {
    // User bubble — show image above text if present
    if (imageDataUrl) {
      const imgWrap = document.createElement('div');
      imgWrap.classList.add('chat-image-wrap');
      const img = document.createElement('img');
      img.classList.add('chat-image');
      img.src = imageDataUrl;
      img.alt = 'Attached image';
      imgWrap.appendChild(img);
      bubble.appendChild(imgWrap);
    }
    if (text) {
      const textNode = document.createElement('div');
      textNode.textContent = text;
      bubble.appendChild(textNode);
    }
  }

  const ts = document.createElement('div');
  ts.classList.add('ts');
  ts.textContent = getTime();

  inner.appendChild(bubble);
  inner.appendChild(ts);

  if (role === 'ai') {
    const avatar = document.createElement('div');
    avatar.classList.add('avatar');
    avatar.innerHTML = `<svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;">
      <path stroke="#00FF66" stroke-width="2.2" stroke-linecap="round" d="M35,8 C10,22 18,42 48,49"/>
      <path stroke="#00FF66" stroke-width="2.2" stroke-linecap="round" d="M65,8 C90,22 82,42 52,49"/>
      <path stroke="#00FF66" stroke-width="2.2" stroke-linecap="round" d="M35,92 C10,78 18,58 48,51"/>
      <path stroke="#00FF66" stroke-width="2.2" stroke-linecap="round" d="M65,92 C90,78 82,58 52,51"/>
      <path stroke="#00FF66" stroke-width="1.6" stroke-linecap="round" opacity="0.65" d="M8,38 C22,10 42,18 49,48"/>
      <path stroke="#00FF66" stroke-width="1.6" stroke-linecap="round" opacity="0.65" d="M8,62 C22,90 42,82 49,52"/>
      <path stroke="#00FF66" stroke-width="1.6" stroke-linecap="round" opacity="0.65" d="M92,38 C78,10 58,18 51,48"/>
      <path stroke="#00FF66" stroke-width="1.6" stroke-linecap="round" opacity="0.65" d="M92,62 C78,90 58,82 51,52"/>
      <circle cx="50" cy="50" r="38" stroke="#00FF66" stroke-width="0.5" opacity="0.12"/>
      <circle cx="50" cy="50" r="24" stroke="#00FF66" stroke-width="0.4" opacity="0.09"/>
      <circle cx="50" cy="50" r="3" fill="#00FF66"/>
    </svg>`;
    row.appendChild(avatar);
    row.appendChild(inner);
  } else {
    row.appendChild(inner);
  }

  if (messagesEl) messagesEl.appendChild(row);
  scrollToBottom();
  return { row, bubble };
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
  const imageToSend = attachedImageBase64; // capture before clearImageAttachment wipes it
  appendMessage('user', text, false, imageToSend);
  inputEl.value = '';
  autoResize();

  const { row } = appendMessage('ai', '', true);
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
        image: attachedImageBase64   
      }),
    });

    if (requestId !== currentRequestId) return;
    if (res.status === 499) return;

    let data;
    try { data = await res.json(); } catch { return; }

    if (requestId !== currentRequestId) return;

    const reply = data.reply || "No response";

    if (thinkingRow) { thinkingRow.remove(); thinkingRow = null; }

    const { bubble } = appendMessage('ai', '');
    chatHistory.push({ role: 'assistant', content: reply });

    await typeText(bubble, reply, requestId);

  } catch (err) {
    if (err.name === "AbortError") return;
    if (requestId !== currentRequestId) return;
    console.error(err);
    if (thinkingRow) thinkingRow.remove();
    appendMessage('ai', '❌ Error connecting to server');
  }

  if (requestId === currentRequestId) {
    isThinking = false;
    controller = null;
    setStopMode(false);
    clearImageAttachment();
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
(async () => {
  await initAuthToken();
  loadSidebarHistory();
})();

// ─── LOGOUT LOGIC ────────────────────────────────────
const logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    // Show loading state on button (optional, but good UX)
    const originalText = logoutBtn.innerHTML;
    logoutBtn.innerHTML = '<span class="btn-label" style="max-width:200px;opacity:1;">Logging out...</span>';
    
    try {
      // 1. Fetch config to get Supabase URL and Anon Key
      const res = await fetch('/api/config');
      const { supabaseUrl, supabaseAnonKey } = await res.json();
      
      // 2. Import Supabase client dynamically to avoid turning script.js into a module
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
      const supabase = createClient(supabaseUrl, supabaseAnonKey);
      
      // 3. Sign out via Supabase
      await supabase.auth.signOut();
      
      // 4. Redirect
      window.location.replace('/auth.html');
    } catch (e) {
      console.error('Logout error:', e);
      // Fallback: manually remove session if network fails
      localStorage.removeItem('sb-pumnywxnpwgmurjqtdhr-auth-token');
      window.location.replace('/auth.html');
    }
  });
}