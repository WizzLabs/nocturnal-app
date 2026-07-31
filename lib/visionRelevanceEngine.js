// ─── VISION RELEVANCE ENGINE ─────────────────────────────
// Sprint 8A.7: decides whether a CACHED Vision Analysis should be reused
// for the current turn. Fixes the "sticky vision context" bug — until
// now, once an image was analyzed, EVERY follow-up in that session got
// the full analysis re-injected regardless of whether the question had
// anything to do with the image (see server.js's old unconditional
// `if (cachedAnalysis) { ...inject... }` branch). This module is what
// that branch now checks first.
//
//   Vision Analysis Exists → Current Question → score() → USE_VISION | IGNORE_VISION
//
// Example:
//   image: photo of a car, question: "what color is it?" → USE_VISION
//   image: photo of a car, question: "who is Messi?"      → IGNORE_VISION
//
// Deliberately the smallest change that fixes the bug: this is
// DocumentRelevanceEngine's exact scoring shape, retargeted at a Vision
// Analysis object (services/vision/promptBuilder.js's shape: description,
// ocr, objects, scene) instead of raw document text. No embeddings, no
// external API calls, per free-tier philosophy — same as its document
// counterpart. Pure and stateless: never touches services/vision/context.js
// (the cache) directly — callers own fetching the cached analysis and
// acting on the decision; this module only judges relevance.

export const CONFIG = {
  // score >= this → USE_VISION. Recency alone (max 0.10 weight below)
  // can never cross this on its own, so an unrelated follow-up doesn't
  // get the image re-injected just because it was analyzed a moment ago.
  USE_THRESHOLD: 0.20,

  // Must sum to <= 1.0 for the final score to stay within [0, 1].
  WEIGHTS: {
    tokenOverlap: 0.35,
    keywordWeight: 0.25,
    exactPhrase: 0.20,
    objectBoost: 0.10,
    recency: 0.10,
  },

  RECENCY_FULL_BOOST_MS: 60 * 1000,      // < 1 min old → full recency credit
  RECENCY_DECAY_MS: 5 * 60 * 1000,       // fades to ~0 credit by 5 min old

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

function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.]+/i)
    .map(t => t.replace(/^\.+|\.+$/g, ''))
    .filter(t => t.length >= CONFIG.MIN_TOKEN_LENGTH && !STOPWORDS.has(t));
}

function ngrams(words, n) {
  const result = [];
  for (let i = 0; i <= words.length - n; i++) {
    result.push(words.slice(i, i + n).join(' '));
  }
  return result;
}

function tokenWeight(token) {
  if (token.length >= 7) return 1.5;
  if (token.length >= 5) return 1.0;
  return 0.6;
}

// Flattens the Vision Analysis (description/ocr/objects/scene) into one
// lowercase text blob for scoring, and a token set for overlap checks.
function analysisText(analysis) {
  if (!analysis) return '';
  const objects = Array.isArray(analysis.objects) ? analysis.objects.join(' ') : '';
  return [analysis.description, analysis.ocr, objects, analysis.scene]
    .filter(Boolean)
    .join(' ');
}

function scoreTokenOverlap(questionTokens, analysisTokenSet) {
  if (!questionTokens.length) return { value: 0, matched: [] };
  const uniqueQ = [...new Set(questionTokens)];
  const matched = uniqueQ.filter(t => analysisTokenSet.has(t));
  return { value: matched.length / uniqueQ.length, matched };
}

function scoreKeywordWeight(questionTokens, analysisTokenSet) {
  const uniqueQ = [...new Set(questionTokens)];
  if (!uniqueQ.length) return { value: 0, matched: [] };
  let totalWeight = 0;
  let matchedWeight = 0;
  const matched = [];
  for (const token of uniqueQ) {
    const w = tokenWeight(token);
    totalWeight += w;
    if (analysisTokenSet.has(token)) {
      matchedWeight += w;
      matched.push(token);
    }
  }
  return { value: totalWeight > 0 ? matchedWeight / totalWeight : 0, matched };
}

function scoreExactPhrase(question, analysisTextLower) {
  const words = question.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { value: 0, matched: [] };

  const candidates = [...ngrams(words, 3), ...ngrams(words, 2)]
    .map(p => p.replace(/[^a-z0-9_. ]/gi, '').trim())
    .filter(p => p.length >= 6);

  if (!candidates.length) return { value: 0, matched: [] };

  const matched = [];
  for (const phrase of candidates) {
    if (analysisTextLower.includes(phrase)) matched.push(phrase);
  }
  if (!matched.length) return { value: 0, matched: [] };

  const value = Math.min(1, matched.length / Math.max(2, candidates.length * 0.4));
  return { value, matched: [...new Set(matched)] };
}

// Objects are curated, specific nouns ("car", "laptop", "whiteboard") —
// a question mentioning one is strong, precise evidence, so it gets its
// own boost distinct from the general token-overlap score.
function scoreObjectBoost(questionTokens, objects) {
  if (!Array.isArray(objects) || !objects.length) return { value: 0, matched: [] };
  const objectTokens = new Set(objects.flatMap(o => tokenize(String(o))));
  if (!objectTokens.size) return { value: 0, matched: [] };

  const uniqueQ = [...new Set(questionTokens)];
  const matched = uniqueQ.filter(t => objectTokens.has(t));
  if (!matched.length) return { value: 0, matched: [] };

  return { value: Math.min(1, matched.length / Math.min(3, objectTokens.size)), matched };
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

// Scores how relevant a cached Vision Analysis is to the current question.
//
// Params:
//   question  — the user's current message (string)
//   analysis  — the Vision Analysis object (services/vision/promptBuilder.js
//               shape: { description, ocr, objects, scene, confidence })
//   updatedAt — ms timestamp the analysis was cached (for the recency
//               component) — optional, defaults to no recency credit
//   options   — optional per-call overrides: { threshold, weights }
//
// Returns: { score: number (0..1), matchedTerms: string[], decision: 'USE_VISION' | 'IGNORE_VISION' }
//
// Never throws — a missing/malformed analysis or empty question resolves
// to a confident IGNORE_VISION rather than an error, since a
// relevance-engine failure must never break the chat pipeline (same
// fail-closed philosophy as documentRelevanceEngine.js/planner.js).
export function score(question, analysis, updatedAt, options = {}) {
  const threshold = typeof options.threshold === 'number' ? options.threshold : CONFIG.USE_THRESHOLD;
  const weights = { ...CONFIG.WEIGHTS, ...(options.weights || {}) };

  if (typeof question !== 'string' || !question.trim() || !analysis) {
    return { score: 0, matchedTerms: [], decision: 'IGNORE_VISION' };
  }

  const text = analysisText(analysis);
  if (!text.trim()) {
    return { score: 0, matchedTerms: [], decision: 'IGNORE_VISION' };
  }

  const questionTokens = tokenize(question);
  const analysisTokenSet = new Set(tokenize(text));
  const textLower = text.toLowerCase();

  const overlap = scoreTokenOverlap(questionTokens, analysisTokenSet);
  const keyword = scoreKeywordWeight(questionTokens, analysisTokenSet);
  const phrase = scoreExactPhrase(question, textLower);
  const objectBoost = scoreObjectBoost(questionTokens, analysis.objects);
  const recency = scoreRecency(updatedAt);

  const rawScore =
    weights.tokenOverlap * overlap.value +
    weights.keywordWeight * keyword.value +
    weights.exactPhrase * phrase.value +
    weights.objectBoost * objectBoost.value +
    weights.recency * recency;

  const finalScore = Math.max(0, Math.min(1, rawScore));

  const matchedTerms = [...new Set([...overlap.matched, ...keyword.matched, ...phrase.matched, ...objectBoost.matched])]
    .slice(0, CONFIG.MAX_MATCHED_TERMS);

  return {
    score: Math.round(finalScore * 1000) / 1000,
    matchedTerms,
    decision: finalScore >= threshold ? 'USE_VISION' : 'IGNORE_VISION',
  };
}

export default { score, CONFIG };
