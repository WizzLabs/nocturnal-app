// ─── SEARCH SERVICE ──────────────────────────────────────
// Public entrypoint for all search in Nocturnal. server.js (and any other
// caller) should only ever talk to this module — never to a provider file
// or the cache module directly.
//
//   server.js → SearchService.search() → provider → normalized results → AI
//
// Every provider module must export a default object shaped like:
//   {
//     name: 'tavily',
//     search: async (query, opts) => [{ title, url, snippet, publishedDate }, ...]
//   }
// `search()` should throw on failure — SearchService is responsible for
// catching and failing safe (never let a search error break /chat).
//
// To add a new provider later: create services/search/<name>.js implementing
// this same shape, add it to the registry below, and set
// SEARCH_PROVIDER=<name> in .env. Nothing else in the app needs to change.
// Planned future providers: Brave Search, SearXNG, DuckDuckGo.

import tavilyProvider from './tavily.js';
import { getCached, setCached } from './cache.js';
import { SEARCH_CONFIG } from '../../config/search.js';

const registry = {
  tavily: tavilyProvider,
};

// Cache the resolved provider instance — env var doesn't change at runtime.
let cachedProvider = null;

function resolveProvider() {
  if (cachedProvider) return cachedProvider;

  const name = (process.env.SEARCH_PROVIDER || SEARCH_CONFIG.defaultProvider).toLowerCase();
  const provider = registry[name];

  if (!provider) {
    throw new Error(
      `Unknown SEARCH_PROVIDER "${name}". Available: ${Object.keys(registry).join(', ')}`
    );
  }

  cachedProvider = provider;
  return provider;
}

// Exposed for callers that just want to log/display which provider is
// active (e.g. server.js's existing `[Search] ${provider.name}` log).
export function getSearchProviderName() {
  return resolveProvider().name;
}

// ─── PUBLIC INTERFACE ────────────────────────────────────
// search(query, options) -> { provider, query, results }
//
// options:
//   category   — routing category from the planner, drives cache TTL
//                and (inside the provider) recency behavior
//   maxResults — overrides config/search.js's default result count
//
// Handles cache lookup/write internally so callers never reason about
// caching. Throws only when both cache miss AND the provider call fails —
// callers (server.js) are still responsible for catching that and
// proceeding without search context, exactly as before.
export async function search(query, options = {}) {
  const { category } = options;
  const isDev = process.env.NODE_ENV !== 'production';

  const cached = getCached(query, category);
  if (cached) {
    if (isDev) console.log('[Search] Cache HIT');
    return {
      provider: getSearchProviderName(),
      query,
      results: cached,
    };
  }
  if (isDev) console.log('[Search] Cache MISS');

  const provider = resolveProvider();
  const results = await provider.search(query, {
    category,
    maxResults: options.maxResults ?? SEARCH_CONFIG.maxResults,
  });

  setCached(query, results, category);

  return {
    provider: provider.name,
    query,
    results,
  };
}

export default { search, getSearchProviderName };
