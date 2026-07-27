// ─── CONVERSATION ENTITY STORE ──────────────────────────
// Sprint 3.3: lightweight, session-scoped memory used ONLY by routing
// (ContextResolver / SearchRouter) to resolve pronouns like "it"/"he"/
// "they" in follow-up search queries. This is explicitly NOT the
// Knowledge Engine (cross-chat, durable-fact memory) described in the
// project architecture — it holds at most one "current subject" per
// active conversation, expires quickly, and is never read by anything
// other than the routing layer.
//
//   "Who created Python?"        → entity store: { entity: "Python" }
//   "What's the latest version of it?"
//                                 → ContextResolver reads "Python" back
//
// Keyed by sessionId so concurrent users/conversations never collide.
// In-memory Map, same pattern/tradeoffs as services/search/cache.js — a
// single-process store, fine for a self-hosted deployment. If Nocturnal
// ever runs across multiple instances, swap for a Redis-backed
// implementation without touching any caller.

const store = new Map(); // sessionId -> { entity, aliases: Set<string>, lastQuery, updatedAt }

// Conversations are short-lived from a routing perspective — 30 minutes
// of inactivity is more than enough for "what version is it?" to still
// resolve, without the store growing unbounded for abandoned sessions.
const ENTRY_TTL_MS = 30 * 60 * 1000;

function isExpired(entry) {
  return !entry || Date.now() - entry.updatedAt > ENTRY_TTL_MS;
}

// Best-effort cleanup so the Map doesn't grow forever across many distinct
// sessions. Cheap (O(n) over active sessions only) and only runs on write,
// never blocks a read.
function sweep() {
  for (const [key, entry] of store) {
    if (isExpired(entry)) store.delete(key);
  }
}

// Returns the current entity for a session, or null if none/expired.
// Shape: { entity: string, aliases: string[], lastQuery: string }
export function getEntity(sessionId) {
  if (!sessionId) return null;
  const entry = store.get(sessionId);
  if (isExpired(entry)) {
    if (entry) store.delete(sessionId);
    return null;
  }
  return { entity: entry.entity, aliases: [...entry.aliases], lastQuery: entry.lastQuery };
}

// Records/refreshes the "current subject" for a session. Called whenever
// routing identifies a clear entity — a successful search, a planner
// decision with an identifiable subject, or a stable-knowledge CHAT
// answer that introduces a primary entity (e.g. "Who created Python?").
//
// entity   — the canonical name to substitute pronouns with, e.g. "Python"
// lastQuery — the query that produced/confirmed this entity, for debugging
export function setEntity(sessionId, entity, lastQuery = '') {
  if (!sessionId || !entity || !entity.trim()) return;
  sweep();
  const existing = store.get(sessionId);
  const aliases = existing && existing.entity === entity ? existing.aliases : new Set();
  store.set(sessionId, {
    entity: entity.trim(),
    aliases,
    lastQuery,
    updatedAt: Date.now(),
  });
}

// Exposed for debugging/tests only.
export function _clear() {
  store.clear();
}

export default { getEntity, setEntity };
