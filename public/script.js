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
const attachBtn          = document.getElementById('attach-btn');
const imagePreviewBox    = document.getElementById('image-preview-box');
const previewImg         = document.getElementById('preview-img');
const removeImgBtn       = document.getElementById('remove-img-btn');
const chatHistoryList    = document.getElementById('chat-history-list');
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
  if (attachBtn) attachBtn.classList.remove('has-file');
}

// ─── MODE TABS ────────────────────────────────────────
if (modeTabsWrap) {
  const tabs = modeTabsWrap.querySelectorAll('.mode-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentMode = tab.dataset.value || 'flash';
    });
  });
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

function appendMessage(role, text, typing = false, imageDataUrl = null, sentAt = null) {
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

  if (typing) {
    const dots = document.createElement('div');
    dots.classList.add('dots');
    for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('span'));
    content.appendChild(dots);
    const label = document.createElement('span');
    label.textContent = 'processing…';
    content.appendChild(label);
  } else if (role === 'ai' && text) {
    content.appendChild(renderMarkdown(text));
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
  return { row, bubble: content };
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
