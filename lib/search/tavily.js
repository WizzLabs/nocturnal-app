// ─── TAVILY SEARCH PROVIDER ────────────────────────────
// Implements the generic search provider interface (see lib/search/index.js)
// against Tavily's REST API.
//
// Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const DEFAULT_MAX_RESULTS = 5;
const REQUEST_TIMEOUT_MS = 8000; // search must never hold up /chat for long
const isDev = process.env.NODE_ENV !== 'production';

// Categories where the answer changes fast enough that an un-dated,
// relevance-ranked result can be actively wrong (not just slightly stale).
// These get topic:'news' + a short time_range so Tavily prioritizes recent
// pages over generically "relevant" ones. Everything else keeps Tavily's
// default general search, which is fine for slower-moving topics.
const RECENCY_SENSITIVE_CATEGORIES = new Set([
  'current_affairs',
  'sports',
  'finance',
]);

async function search(query, opts = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not configured.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const useNewsMode = RECENCY_SENSITIVE_CATEGORIES.has(opts.category);

  const requestBody = {
    query,
    max_results: opts.maxResults || DEFAULT_MAX_RESULTS,
    search_depth: 'basic',
    include_answer: false,
    // Recency controls: without these, Tavily ranks by relevance only,
    // which can surface an older page over the current one for evergreen
    // phrasings like "who is the current president". For recency-sensitive
    // categories, bias hard toward fresh results.
    topic: useNewsMode ? 'news' : 'general',
    ...(useNewsMode ? { time_range: 'week' } : {}),
  };

  if (isDev) {
    console.log('[Search] Tavily request:', JSON.stringify({ query, topic: requestBody.topic, time_range: requestBody.time_range || null }));
  }

  try {
    const response = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`Tavily request failed (${response.status}): ${bodyText.slice(0, 200)}`);
    }

    const data = await response.json();

    if (isDev) {
      // Full raw response, dev-only — this is the ground truth for
      // diagnosing "search ran but the fact is still wrong" issues.
      console.log('[Search] Tavily raw response:', JSON.stringify(data).slice(0, 4000));
    }

    const results = Array.isArray(data.results) ? data.results : [];

    return results.map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: (r.content || '').trim(),
      // Previously dropped — needed so the formatter/model can tell a
      // fresh result apart from a stale one instead of treating every
      // snippet as equally current.
      publishedDate: r.published_date || null,
    }));
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  name: 'tavily',
  search,
};
