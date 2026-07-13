// ─── GENERIC SEARCH PROVIDER INTERFACE ─────────────────
// Every provider module must export a default object shaped like:
//   {
//     name: 'tavily',
//     search: async (query, opts) => [{ title, url, snippet }, ...]
//   }
// `search()` should throw on failure — callers are responsible for
// catching and failing safe (never let a search error break /chat).
//
// To add a new provider later: create lib/search/<name>.js implementing
// this same shape, add it to the registry below, and set
// SEARCH_PROVIDER=<name> in .env. Nothing else in the app needs to change.

import tavilyProvider from './tavily.js';

const registry = {
  tavily: tavilyProvider,
};

// Cache the resolved provider instance — env var doesn't change at runtime.
let cachedProvider = null;

export function getSearchProvider() {
  if (cachedProvider) return cachedProvider;

  const name = (process.env.SEARCH_PROVIDER || 'tavily').toLowerCase();
  const provider = registry[name];

  if (!provider) {
    throw new Error(
      `Unknown SEARCH_PROVIDER "${name}". Available: ${Object.keys(registry).join(', ')}`
    );
  }

  cachedProvider = provider;
  return provider;
}
