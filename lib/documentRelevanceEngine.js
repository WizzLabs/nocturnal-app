// ─── DOCUMENT RELEVANCE ENGINE ───────────────────────────
// Sprint 8A.3: decides whether a CACHED document should be injected into
// the current turn's answer. Fixes the Sprint 6b/7 "sticky document" bug
// — previously, once a document was uploaded, EVERY follow-up in that
// session got the full document re-injected regardless of whether the
// question had anything to do with it (see server.js's old unconditional
// `if (cachedDocument) { ...inject... }` branch). This module is what
// that branch now checks first.
//
//   Document Exists → Current Question → score() → USE_DOCUMENT | IGNORE_DOCUMENT
//
// Example (from the sprint spec):
//   doc: ESP32 Robot notes, question: "Explain setup()"        → USE_DOCUMENT
//   doc: ESP32 Robot notes, question: "Who is the CM of TN?"   → IGNORE_DOCUMENT
//
// Local hybrid scorer only — NO embeddings, no external API calls, per
// free-tier philosophy and explicit sprint instruction. Deliberately
// exposed behind one narrow function so an embedding-based scorer can
// replace everything below CONFIG in a future sprint without any caller
// (server.js today, Planner V2 later) needing to change. The contract is
// just: score(question, documentContext, options?) -> { score,
// matchedTerms, decision }.
//
// Pure and stateless — never touches services/document/context.js (the
// cache) directly. Callers own fetching the cached document and acting
// on the decision; this module only judges relevance.

// ── Configurable thresholds/weights ─────────────────────
// Exported (not buried inline) so they can be tuned, or overridden
// per-call via `options`, without touching the scoring logic itself.
export const CONFIG = {
  // score >= this → USE_DOCUMENT. Deliberately conservative: recency
  // alone (max 0.10 weight below) can never cross this on its own, so a
  // genuinely unrelated question never gets the document injected just
  // because it was uploaded a moment ago.
  USE_THRESHOLD: 0.22,

  // Must sum to <= 1.0 for the final score to stay within [0, 1].
  WEIGHTS: {
    tokenOverlap: 0.30,
    keywordWeight: 0.20,
    exactPhrase: 0.25,
    titleBoost: 0.15,
    recency: 0.10,
  },

  RECENCY_FULL_BOOST_MS: 2 * 60 * 1000,  // < 2 min old → full recency credit
  RECENCY_DECAY_MS: 20 * 60 * 1000,      // fades to ~0 credit by 20 min old

  MIN_TOKEN_LENGTH: 3,
  MAX_MATCHED_TERMS: 15,
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'has', 'have', 'had', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'about', 'and', 'or', 'but', 'if', 'so', 'as', 'by',
  'this', 'that', 'these', 'those', 'it', 'its', 'my', 'your', 'his',
  'her', 'their', 'our', 'i', 'you', 'he', 'she', 'they', 'we', 'me',
  'him', 'them', 'us', 'what', 'who', 'when', 'where', 'why', 'how',
  'can', 'could', 'would', 'will', 'shall', 'should', 'may', 'might',
  'just', 'not', 'no', 'yes', 'tell', 'explain', 'describe', 'please',
]);

// Sprint 8A.8 — Bug fix (Document Relevance False Positives): words that
// survive STOPWORDS (they're not grammatical filler, and some are long
// enough to have earned the max tokenWeight — e.g. "project" is 7 chars,
// scoring the same 1.5x as a genuinely distinctive term like
// "recursion" or "mpu6050") but are common enough in everyday
// conversation that their presence in a cached document is weak
// evidence the CURRENT question is actually about it. Real production
// case: "how's my project going" matched an ESP32 robot document titled
// "ESP32 Robot Project Notes" purely because both contain "project".
// This is NOT a second stopword list — these words still count toward
// tokenOverlap/keywordWeight, just at a heavily reduced weight, so a
// question made ONLY of generic words never crosses the threshold on
// vocabulary alone, while a question combining a generic word with an
// actually-distinctive term (e.g. "what's my project's GPIO wiring")
// still scores normally on the strength of the distinctive term.
const GENERIC_WORDS = new Set([
  'project', 'work', 'working', 'think', 'thing', 'things', 'stuff',
  'time', 'today', 'now', 'later', 'help', 'make', 'making', 'get',
  'getting', 'know', 'want', 'need', 'like', 'good', 'great', 'way',
  'look', 'looking', 'use', 'using', 'used', 'go', 'going', 'come',
  'coming', 'say', 'said', 'see', 'seeing', 'thought', 'idea', 'plan',
  'plans', 'update', 'updates', 'status', 'progress', 'life',
  'day', 'days', 'week', 'month', 'year', 'people', 'person', 'talk',
  'talking', 'question', 'questions', 'answer', 'answers', 'point',
  'part', 'parts', 'kind', 'sort', 'bit', 'lot', 'lots', 'something',
  'anything', 'everything', 'nothing', 'someone', 'anyone', 'everyone',
]);

// Lowercases and splits into word-ish tokens (alphanumeric plus a few
// code-friendly characters like _ and . so "setup()" -> "setup" and
// "esp32" stay intact), dropping stopwords and very short tokens.
function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.]+/i)
    .map(t => t.replace(/^\.+|\.+$/g, ''))
    .filter(t => t.length >= CONFIG.MIN_TOKEN_LENGTH && !STOPWORDS.has(t));
}

// Builds n-grams (contiguous word sequences) from raw text for exact
// phrase matching — phrases carry more signal than lone tokens ("chief
// minister" matching is a much stronger signal than "chief" and
// "minister" separately overlapping).
function ngrams(words, n) {
  const result = [];
  for (let i = 0; i <= words.length - n; i++) {
    result.push(words.slice(i, i + n).join(' '));
  }
  return result;
}

// Weight a token by how much signal it likely carries: longer, less
// generic tokens (e.g. "mpu6050", "recursion") count for more than short
// common ones that survived stopword filtering by accident.
function tokenWeight(token) {
  // Generic vocabulary never earns the long-token bonus, no matter how
  // many characters it has — length was previously used as a proxy for
  // "distinctive", but common words like "project" or "working" are
  // long without being distinctive. See GENERIC_WORDS above.
  if (GENERIC_WORDS.has(token)) return 0.2;
  if (token.length >= 7) return 1.5;
  if (token.length >= 5) return 1.0;
  return 0.6;
}

// ── Component scorers (each returns 0..1) ───────────────

function scoreTokenOverlap(questionTokens, docTokenSet) {
  if (!questionTokens.length) return { value: 0, matched: [] };
  const uniqueQ = [...new Set(questionTokens)];

  // Sprint 8A.8 — Bug fix: a plain match-count ratio treats a generic
  // word ("project", "work") exactly like a distinctive one
  // ("mpu6050"), so a question that's mostly generic vocabulary but
  // happens to share one common word with the document scored the same
  // as genuine topical overlap. Score overlap on the DISTINCTIVE tokens
  // only; generic tokens still contribute (weakly) via keywordWeight,
  // but no longer inflate this component.
  const distinctiveQ = uniqueQ.filter(t => !GENERIC_WORDS.has(t));

  if (!distinctiveQ.length) {
    // Question is entirely generic vocabulary — no distinctive overlap
    // signal is possible, regardless of what the document contains.
    return { value: 0, matched: [] };
  }

  const matched = distinctiveQ.filter(t => docTokenSet.has(t));
  return { value: matched.length / distinctiveQ.length, matched };
}

function scoreKeywordWeight(questionTokens, docTokenSet) {
  const uniqueQ = [...new Set(questionTokens)];
  if (!uniqueQ.length) return { value: 0, matched: [] };
  let totalWeight = 0;
  let matchedWeight = 0;
  const matched = [];
  for (const token of uniqueQ) {
    const w = tokenWeight(token);
    totalWeight += w;
    if (docTokenSet.has(token)) {
      matchedWeight += w;
      matched.push(token);
    }
  }
  return { value: totalWeight > 0 ? matchedWeight / totalWeight : 0, matched };
}

function scoreExactPhrase(question, docTextLower) {
  const words = question.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { value: 0, matched: [] };

  const candidates = [...ngrams(words, 3), ...ngrams(words, 2)]
    .map(p => p.replace(/[^a-z0-9_. ]/gi, '').trim())
    .filter(p => p.length >= 6);

  if (!candidates.length) return { value: 0, matched: [] };

  const matched = [];
  for (const phrase of candidates) {
    if (docTextLower.includes(phrase)) matched.push(phrase);
  }
  if (!matched.length) return { value: 0, matched: [] };

  // A single solid phrase match is already strong evidence — scale up
  // fast but cap at 1, rather than requiring many phrase matches.
  const value = Math.min(1, matched.length / Math.max(2, candidates.length * 0.4));
  return { value, matched: [...new Set(matched)] };
}

function scoreTitleBoost(questionTokens, fileName, docTextSnippet) {
  const titleSource = [fileName || '', docTextSnippet || ''].join(' ');
  const titleTokens = new Set(tokenize(titleSource));
  if (!titleTokens.size) return { value: 0, matched: [] };

  // Sprint 8A.8 — Bug fix: same reasoning as scoreTokenOverlap — a
  // document title/opening line often contains generic words ("Notes",
  // "Project", "Update"), so matching on those alone is not a real
  // title-relevance signal.
  const uniqueQ = [...new Set(questionTokens)].filter(t => !GENERIC_WORDS.has(t));
  if (!uniqueQ.length) return { value: 0, matched: [] };
  const matched = uniqueQ.filter(t => titleTokens.has(t));
  if (!matched.length) return { value: 0, matched: [] };

  return { value: Math.min(1, matched.length / Math.min(4, titleTokens.size)), matched };
}

function scoreRecency(updatedAt) {
  if (typeof updatedAt !== 'number') return 0;
  const age = Date.now() - updatedAt;
  if (age <= CONFIG.RECENCY_FULL_BOOST_MS) return 1;
  if (age >= CONFIG.RECENCY_DECAY_MS) return 0;
  const span = CONFIG.RECENCY_DECAY_MS - CONFIG.RECENCY_FULL_BOOST_MS;
  return 1 - (age - CONFIG.RECENCY_FULL_BOOST_MS) / span;
}

// ── Public API ───────────────────────────────────────────

// Scores how relevant a cached document is to the current question.
//
// Params:
//   question         — the user's current message (string)
//   documentContext  — the object returned by
//                       services/document/context.js#getDocument():
//                       { text, fileName, docType, truncated, updatedAt }
//   options          — optional per-call overrides: { threshold, weights }
//
// Returns: { score: number (0..1), matchedTerms: string[], decision: 'USE_DOCUMENT' | 'IGNORE_DOCUMENT' }
//
// Never throws — a missing/malformed documentContext or empty question
// resolves to a confident IGNORE_DOCUMENT rather than an error, since a
// relevance-engine failure must never break the chat pipeline (same
// fail-closed philosophy as planner.js).
export function score(question, documentContext, options = {}) {
  const threshold = typeof options.threshold === 'number' ? options.threshold : CONFIG.USE_THRESHOLD;
  const weights = { ...CONFIG.WEIGHTS, ...(options.weights || {}) };

  if (typeof question !== 'string' || !question.trim() || !documentContext || !documentContext.text) {
    return { score: 0, matchedTerms: [], decision: 'IGNORE_DOCUMENT' };
  }

  const questionTokens = tokenize(question);
  const docText = documentContext.text;
  const docTokenSet = new Set(tokenize(docText));
  const docTextLower = docText.toLowerCase();

  const overlap = scoreTokenOverlap(questionTokens, docTokenSet);
  const keyword = scoreKeywordWeight(questionTokens, docTokenSet);
  const phrase = scoreExactPhrase(question, docTextLower);
  const title = scoreTitleBoost(questionTokens, documentContext.fileName, docText.slice(0, 200));
  const recency = scoreRecency(documentContext.updatedAt);

  // Sprint 8A.8 — Bug fix: recency alone must never be what pushes a
  // question over the threshold. It's meant to be a tie-breaking boost
  // for questions that already show real lexical signal, not standalone
  // evidence — a question can be asked seconds after upload and still
  // have nothing to do with the document. Gate recency's contribution on
  // there being *some* keyword/overlap signal already, scaled by how
  // strong that signal is, so "just uploaded" can no longer rescue a
  // question whose only match was generic vocabulary.
  const lexicalSignal = Math.max(overlap.value, keyword.value);
  const effectiveRecency = recency * Math.min(1, lexicalSignal * 2);

  const rawScore =
    weights.tokenOverlap * overlap.value +
    weights.keywordWeight * keyword.value +
    weights.exactPhrase * phrase.value +
    weights.titleBoost * title.value +
    weights.recency * effectiveRecency;

  const finalScore = Math.max(0, Math.min(1, rawScore));

  const matchedTerms = [...new Set([...overlap.matched, ...keyword.matched, ...phrase.matched, ...title.matched])]
    .slice(0, CONFIG.MAX_MATCHED_TERMS);

  return {
    score: Math.round(finalScore * 1000) / 1000,
    matchedTerms,
    decision: finalScore >= threshold ? 'USE_DOCUMENT' : 'IGNORE_DOCUMENT',
  };
}

export default { score, CONFIG };
