// ─── DOCUMENT CONTEXT STORE ──────────────────────────────
// Sprint 7, Objective 8: caches the most recently extracted document text
// per conversation so a follow-up question about an already-uploaded
// document ("what does section 3 say?") doesn't re-parse the file on every
// request. Mirrors services/vision/context.js exactly — same in-memory
// Map + TTL pattern, same lifetime, same single-entry-per-session shape —
// so Vision and Document caching stay two independent instances of one
// well-understood pattern rather than sharing state.
//
// Architecture note: this is Conversation Memory, not the future Knowledge
// Cache. It holds the raw extracted text of at most one document per
// session, expires quickly, and is silently overwritten the moment a new
// document is uploaded. It never summarizes, scores importance, or persists
// beyond the session TTL — if/when the Knowledge Cache (cross-chat,
// milestone-based summaries) is built, it would sit beside this module and
// read from a completed turn, not replace or absorb this cache.

const store = new Map(); // sessionId -> { text, fileName, docType, truncated, updatedAt }

// Matches VisionContext's TTL — long enough for a normal back-and-forth
// about one document, short enough not to grow unbounded for abandoned
// sessions.
const ENTRY_TTL_MS = 30 * 60 * 1000;

function isExpired(entry) {
  return !entry || Date.now() - entry.updatedAt > ENTRY_TTL_MS;
}

function sweep() {
  for (const [key, entry] of store) {
    if (isExpired(entry)) store.delete(key);
  }
}

// Returns the cached document (text + metadata) for a session, or null if
// none/expired.
export function getDocument(sessionId) {
  if (!sessionId) return null;
  const entry = store.get(sessionId);
  if (isExpired(entry)) {
    if (entry) store.delete(sessionId);
    return null;
  }
  return entry;
}

// Stores/overwrites the extracted document for a session. Called once per
// successful extraction — a new document always replaces the old one,
// since only the most recently uploaded document is relevant to follow-ups.
export function setDocument(sessionId, { text, fileName, docType, truncated }) {
  if (!sessionId || !text) return;
  sweep();
  store.set(sessionId, { text, fileName, docType, truncated: !!truncated, updatedAt: Date.now() });
}

// Exposed for debugging/tests only.
export function _clear() {
  store.clear();
}

export default { getDocument, setDocument, _clear };
