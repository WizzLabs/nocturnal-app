// ─── CONVERSATION ENTITY STORE ──────────────────────────
// Sprint 3.3: lightweight, session-scoped memory used by routing
// (ContextResolver / SearchRouter) to resolve pronouns like "it"/"he"/
// "they" in follow-up queries.
//
// Sprint 8A.1: upgraded from "one current subject per session" to a
// typed, multi-entity store — the foundation Objective 3 (Entity Memory)
// and Objective 4 (Pronoun Resolution V2) build on. This is still NOT the
// Knowledge Engine (cross-chat, durable-fact memory) described in the
// project architecture — everything here is session-scoped and expires
// on the same short TTL as before. It's just no longer limited to a
// single tracked name.
//
//   "Who created Python?"        → entities: [{ name: "Python", type: "Unknown" }]
//   "What's the latest version of it?"
//                                 → ContextResolver reads "Python" back (getEntity)
//
// Backward compatibility (important — do not break Sprint 7):
//   getEntity(sessionId) / setEntity(sessionId, entity, lastQuery) keep
//   their exact original signatures and return shapes. They are now thin
//   wrappers around the new multi-entity API (getPrimaryEntity /
//   recordEntity) rather than the whole store. Every existing caller
//   (contextResolver.js) works unchanged.
//
// Keyed by sessionId so concurrent users/conversations never collide.
// In-memory Map, same pattern/tradeoffs as services/search/cache.js — a
// single-process store, fine for a self-hosted deployment. If Nocturnal
// ever runs across multiple instances, swap for a Redis-backed
// implementation without touching any caller.

// sessionId -> { entities: Map<normalizedName, EntityRecord>, order: string[] (MRU first), updatedAt }
// EntityRecord: { name, type, confidence, timestamp, source, lastQuery, aliases: Set<string> }
const store = new Map();

// Conversations are short-lived from a routing perspective — 30 minutes
// of inactivity is more than enough for "what version is it?" to still
// resolve, without the store growing unbounded for abandoned sessions.
const ENTRY_TTL_MS = 30 * 60 * 1000;

// Hard cap per session so a very long conversation can't grow the store
// unbounded — least-recently-used entity is evicted first. 20 is well
// above what a normal conversation needs to keep resolvable at once.
const MAX_ENTITIES_PER_SESSION = 20;

// Recognized entity types (Objective 3). "Unknown" is a valid, expected
// value — callers that don't know/care about type (e.g. the legacy
// setEntity path, or a low-confidence extraction) should use it rather
// than guessing.
export const ENTITY_TYPES = [
  'Person', 'Organization', 'Location', 'Programming Language',
  'Framework', 'Database', 'Hardware', 'Sensor', 'Library', 'Company',
  'Project', 'Model', 'File', 'Document', 'Unknown',
];
const ENTITY_TYPE_SET = new Set(ENTITY_TYPES);

function isExpired(entry) {
  return !entry || Date.now() - entry.updatedAt > ENTRY_TTL_MS;
}

// Best-effort cleanup so the Map doesn't grow forever across many distinct
// sessions. Cheap (O(n) over active sessions only) and only runs on write,
// never blocks a read.
function sweepSessions() {
  for (const [key, entry] of store) {
    if (isExpired(entry)) store.delete(key);
  }
}

function normalizeKey(name) {
  return name.trim().toLowerCase();
}

function toPublicRecord(record) {
  return {
    name: record.name,
    type: record.type,
    confidence: record.confidence,
    timestamp: record.timestamp,
    source: record.source,
    lastQuery: record.lastQuery,
    aliases: [...record.aliases],
  };
}

// ── New multi-entity API (Sprint 8A.1) ──────────────────

// Records/refreshes an entity for a session. Upserts by case-insensitive
// name match (merging aliases + refreshing recency/confidence/timestamp
// on repeat mentions) rather than creating duplicates, and evicts the
// least-recently-used entity if the session is at capacity.
//
// Params (all but sessionId/name optional, sensible defaults):
//   name       — canonical display name, e.g. "ESP32"
//   type       — one of ENTITY_TYPES; falls back to "Unknown" if omitted
//                or unrecognized (never throws on a bad/typo'd type —
//                entity storage must never break the request pipeline)
//   confidence — 0.0–1.0, defaults to 0.6 (moderate-confidence heuristic)
//   source     — free-text provenance for debugging, e.g. "planner",
//                "context_resolver", "legacy"
//   lastQuery  — the message/query that produced this mention
export function recordEntity(sessionId, { name, type, confidence = 0.6, source = 'unspecified', lastQuery = '' } = {}) {
  if (!sessionId || typeof name !== 'string' || !name.trim()) return null;

  sweepSessions();

  const cleanName = name.trim();
  const resolvedType = ENTITY_TYPE_SET.has(type) ? type : 'Unknown';
  const key = normalizeKey(cleanName);

  let session = store.get(sessionId);
  if (isExpired(session)) session = null;
  if (!session) {
    session = { entities: new Map(), order: [], updatedAt: Date.now() };
  }

  const existing = session.entities.get(key);
  const aliases = existing ? existing.aliases : new Set();
  if (existing && existing.name !== cleanName) aliases.add(existing.name);

  const record = {
    name: cleanName,
    type: resolvedType,
    confidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : 0.6,
    timestamp: Date.now(),
    source,
    lastQuery,
    aliases,
  };
  session.entities.set(key, record);

  // Move to front of MRU order (dedupe first).
  session.order = session.order.filter(k => k !== key);
  session.order.unshift(key);

  // Evict least-recently-used entity beyond the cap.
  while (session.order.length > MAX_ENTITIES_PER_SESSION) {
    const evictKey = session.order.pop();
    session.entities.delete(evictKey);
  }

  session.updatedAt = Date.now();
  store.set(sessionId, session);

  return toPublicRecord(record);
}

// Returns all active (non-expired) entities for a session, most recently
// mentioned first. Optional { limit, type } filters.
export function getEntities(sessionId, { limit, type } = {}) {
  if (!sessionId) return [];
  const session = store.get(sessionId);
  if (isExpired(session)) {
    if (session) store.delete(sessionId);
    return [];
  }

  let results = session.order
    .map(key => session.entities.get(key))
    .filter(Boolean);

  if (type) results = results.filter(r => r.type === type);
  if (typeof limit === 'number') results = results.slice(0, limit);

  return results.map(toPublicRecord);
}

// Returns the single most recently mentioned entity of a given type, or
// null. Useful for pronoun resolution once it becomes type-aware (e.g.
// "his final movie" should prefer the most recent Person, not just the
// most recent entity of any type).
export function getEntityByType(sessionId, type) {
  const [first] = getEntities(sessionId, { type, limit: 1 });
  return first || null;
}

// Returns the most recently mentioned entity of any type, or null.
export function getPrimaryEntity(sessionId) {
  const [first] = getEntities(sessionId, { limit: 1 });
  return first || null;
}

// ── Legacy API (Sprint 3.3 contract — unchanged shape) ──
// Preserved exactly so contextResolver.js and any other existing caller
// keep working without modification. Internally these are now thin
// wrappers over the multi-entity store above.

// Returns the current ("primary") entity for a session, or null if
// none/expired. Shape unchanged from the original single-entity store:
// { entity: string, aliases: string[], lastQuery: string }
export function getEntity(sessionId) {
  const primary = getPrimaryEntity(sessionId);
  if (!primary) return null;
  return { entity: primary.name, aliases: primary.aliases, lastQuery: primary.lastQuery };
}

// Records/refreshes the "current subject" for a session. Same signature
// as the original implementation — callers that don't know an entity
// type keep working exactly as before, just tagged "Unknown"/"legacy"
// internally now instead of untyped.
export function setEntity(sessionId, entity, lastQuery = '') {
  if (!sessionId || !entity || !entity.trim()) return;
  recordEntity(sessionId, { name: entity, type: 'Unknown', confidence: 0.6, source: 'legacy', lastQuery });
}

// Exposed for debugging/tests only.
export function _clear() {
  store.clear();
}

export default {
  getEntity,
  setEntity,
  recordEntity,
  getEntities,
  getEntityByType,
  getPrimaryEntity,
  ENTITY_TYPES,
};
