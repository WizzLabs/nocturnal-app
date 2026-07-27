// ─── SEARCH CONTEXT FORMATTER ───────────────────────────
// Turns raw provider results into a short, source-attributed block that
// gets injected into the system prompt. Capped in both result count and
// total character length so live context can never dominate/derail the
// main model's prompt or balloon token usage.

const MAX_RESULTS_IN_CONTEXT = 4;
const MAX_SNIPPET_CHARS = 300;
const MAX_TOTAL_CHARS = 1600;
const isDev = process.env.NODE_ENV !== 'production';

export function formatSearchContext(results, query) {
  if (!Array.isArray(results) || results.length === 0) return null;

  const trimmedResults = results.slice(0, MAX_RESULTS_IN_CONTEXT);
  const today = new Date().toISOString().slice(0, 10);

  const lines = trimmedResults.map((r, i) => {
    const snippet = (r.snippet || '').slice(0, MAX_SNIPPET_CHARS).trim();
    const title = r.title || 'Untitled source';
    const url = r.url || '';
    // Surface the publish date when we have one, so the model can weigh a
    // dated result over an undated/older one instead of treating every
    // snippet as equally current — this was previously dropped entirely.
    const dateTag = r.publishedDate ? ` — published ${r.publishedDate}` : '';
    return `[${i + 1}] ${title}${url ? ` (${url})` : ''}${dateTag}\n${snippet}`;
  });

  let block = `Today's date is ${today}. Live web search results for "${query}":\n\n${lines.join('\n\n')}`;

  if (block.length > MAX_TOTAL_CHARS) {
    block = block.slice(0, MAX_TOTAL_CHARS).trim() + '…';
  }

  if (isDev) {
    console.log('[Search] Formatted context injected into prompt:\n' + block);
  }

  return block;
}
