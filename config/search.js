// ─── SEARCH CONFIGURATION ───────────────────────────────
// Single source of truth for Search Service defaults. Mirrors the pattern
// in config/models.js — values live here, not scattered as inline literals
// across services/search/*.js or server.js.
//
// To change a default, edit it here. To swap the active provider, set
// SEARCH_PROVIDER in .env (see services/search/index.js registry).

import { knownCategories } from '../services/search/cache.js';

export const SEARCH_CONFIG = {
  // Provider used when SEARCH_PROVIDER env var is unset.
  defaultProvider: 'tavily',

  // Max results requested from the provider per query.
  maxResults: 5,

  // Provider request timeout — search must never hold up /chat for long.
  timeoutMs: 8000,

  // Cache TTL is actually resolved per-category (see services/search/cache.js
  // CATEGORY_TTL_MS). This is only the fallback for an unrecognized/blank
  // category, kept here so it's visible alongside the other search defaults.
  defaultCacheTtlMs: 15 * 60 * 1000, // 15 min

  // Recognized search categories, shared with the planner's routing enum.
  // Sourced from cache.js so the TTL table and this list never drift apart.
  categories: knownCategories(),
};

export default SEARCH_CONFIG;
