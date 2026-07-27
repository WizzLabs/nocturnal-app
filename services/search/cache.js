// ─── SEARCH RESULT CACHE ───────────────────────────────
// Simple in-memory cache keyed by normalized query text, with TTL decided
// per CATEGORY rather than a single global value. Callers (planner, chat
// pipeline) never see or reason about TTL — they just pass a category
// string alongside the query, and this module decides how long that
// category's results stay fresh. This is a single-process cache (fine for
// a self-hosted deployment) — if Nocturnal ever runs across multiple
// instances, swap this module for a Redis-backed implementation without
// touching any caller.

const store = new Map(); // normalizedQuery -> { value, expiresAt, category }

// ─── CATEGORY → TTL TABLE ───────────────────────────────
// Small, maintainable, and the only place category freshness lives. Add a
// new category here (and to the planner's enum) to give it its own TTL —
// nothing else in the app needs to change.
//
// Rationale for defaults:
// - current_affairs / sports: change by the minute, short TTL
// - finance: markets move fast during trading hours, short TTL
// - weather: changes over hours, short-to-medium TTL
// - technology / public_figures: change over days, medium TTL
// - general_news: broad catch-all, medium TTL
// - default: unknown/uncategorized, conservative medium TTL
const CATEGORY_TTL_MS = {
  current_affairs: 5 * 60 * 1000,     // 5 min
  sports:           5 * 60 * 1000,     // 5 min
  finance:          5 * 60 * 1000,     // 5 min
  weather:          30 * 60 * 1000,    // 30 min
  technology:       60 * 60 * 1000,    // 1 hour
  public_figures:   60 * 60 * 1000,    // 1 hour
  general_news:     30 * 60 * 1000,    // 30 min
  default:          15 * 60 * 1000,    // 15 min — unknown/uncategorized
};

// A global override still works (e.g. to force everything short in dev,
// or disable caching entirely with 0) — if set, it takes precedence over
// the per-category table so existing SEARCH_CACHE_TTL_MS deployments don't
// silently change behavior.
function resolveTtlMs(category) {
  const override = parseInt(process.env.SEARCH_CACHE_TTL_MS, 10);
  if (Number.isFinite(override)) return override; // includes 0 = disabled

  return CATEGORY_TTL_MS[category] ?? CATEGORY_TTL_MS.default;
}

function normalize(query) {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function getCached(query, category) {
  const key = normalize(query);
  const entry = store.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

export function setCached(query, value, category) {
  const ttlMs = resolveTtlMs(category);
  if (ttlMs === 0) return; // TTL of 0 = caching disabled
  const key = normalize(query);
  store.set(key, { value, expiresAt: Date.now() + ttlMs, category: category || 'default' });
}

// Exposed for /api/search-cache/stats or manual debugging if ever needed.
export function cacheSize() {
  return store.size;
}

// Exposed so new categories can be validated/introspected elsewhere
// (e.g. the planner's enum) without duplicating the list.
export function knownCategories() {
  return Object.keys(CATEGORY_TTL_MS);
}
