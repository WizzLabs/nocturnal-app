// ─── VISION CONTEXT STORE ────────────────────────────────
// Sprint 4, Objective 8: caches the most recent Vision Analysis per
// conversation so a follow-up question about an already-analyzed image
// ("what color is the car?") doesn't trigger a second Vision Model call.
//
// Same in-memory Map + TTL pattern as lib/entityStore.js — a single-process
// store, fine for a self-hosted deployment. If Nocturnal ever runs across
// multiple instances, swap for a Redis-backed implementation without
// touching any caller.
//
// This is explicitly NOT the Knowledge Engine (cross-chat, durable-fact
// memory). It holds at most one Vision Analysis per session, expires
// quickly, and is overwritten the moment a new image is uploaded.

const store = new Map(); // sessionId -> { analysis, updatedAt }

// Matches entityStore.js's TTL — long enough for a normal back-and-forth
// about one image, short enough not to grow unbounded for abandoned
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

// Returns the cached Vision Analysis for a session, or null if none/expired.
export function getAnalysis(sessionId) {
  if (!sessionId) return null;
  const entry = store.get(sessionId);
  if (isExpired(entry)) {
    if (entry) store.delete(sessionId);
    return null;
  }
  return entry.analysis;
}

// Sprint 8A.7: same lookup as getAnalysis(), but also returns the cache
// timestamp — needed by lib/visionRelevanceEngine.js's recency component.
// Added as a new export (getAnalysis's own signature/behavior is
// untouched) so every existing caller keeps working unchanged.
export function getAnalysisEntry(sessionId) {
  if (!sessionId) return null;
  const entry = store.get(sessionId);
  if (isExpired(entry)) {
    if (entry) store.delete(sessionId);
    return null;
  }
  return { analysis: entry.analysis, updatedAt: entry.updatedAt };
}

// Stores/overwrites the Vision Analysis for a session. Called once per
// successful image analysis — a new image always replaces the old one,
// since only the most recently uploaded image is relevant to follow-ups.
export function setAnalysis(sessionId, analysis) {
  if (!sessionId || !analysis) return;
  sweep();
  store.set(sessionId, { analysis, updatedAt: Date.now() });
}

// Exposed for debugging/tests only.
export function _clear() {
  store.clear();
}

export default { getAnalysis, getAnalysisEntry, setAnalysis, _clear };
