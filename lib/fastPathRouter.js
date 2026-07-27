// ─── FAST PATH ROUTER ───────────────────────────────────
// Sprint 3.2: a deterministic, zero-cost routing stage that runs BEFORE the
// planner. No LLM call, no API call, no Search — pure code, microseconds.
//
// Why this exists: the planner (lib/planner.js) is an LLM call. Sprint 3
// centralized the decision to search behind it, but that meant EVERY text
// message — including "explain recursion" or "write a login page" — paid
// for a full planner round trip before Flash could even start answering.
// Most messages aren't ambiguous. This module answers the obvious cases
// with regex/keyword checks and only lets genuinely ambiguous messages
// (ones that need conversation context to resolve) fall through to the
// planner.
//
//   server.js → SearchRouter.route()
//                     │
//                     ▼
//              FastPathRouter.classify()
//                 │        │        │
//               CHAT   SEARCH    DEFER
//                                   │
//                                   ▼
//                          planner.planMessage()
//
// Responsibilities (and ONLY these — see Sprint 3.2 spec "Keep Architecture
// Modular"): keyword detection, obvious routing, image detection, planner
// bypass. This module never calls Search, never calls the planner, never
// touches the cache — it only returns a routing verdict. SearchRouter is
// still the single place that OWNS the routing decision and the only
// caller of both this module and the planner.
//
// Fails open toward the planner: if a message doesn't clearly match either
// the CHAT or SEARCH heuristics below, the verdict is DEFER, and the
// planner (conversation-aware, LLM-based) makes the call exactly as it did
// before this sprint. Fast Path never has to be right about everything —
// it only has to be confidently right about the obvious cases.

// ── FRESH-INFORMATION KEYWORDS ──────────────────────────
// Presence of any of these is a strong, near-unambiguous signal that the
// request needs live/external information — the planner would virtually
// always route these to SEARCH anyway, so skip straight there. Kept as a
// flat word/phrase list (not a single mega-regex) so it stays easy to
// extend without fighting regex precedence.
const FRESH_PHRASES = [
  'latest', 'today', "today's", 'current', 'currently', 'news', 'weather',
  'live', 'recently', 'this week', 'this month', 'current version',
  'current president', 'stock price', 'breaking', 'release today',
  'right now', 'as of now',
];

// Rough category guess for the cache/search layer — doesn't need to be
// perfect (SearchService/cache degrade gracefully to "default" TTL on an
// unrecognized category), just a best-effort hint so Fast Path SEARCH
// results still get sensible cache behavior instead of always falling
// back to "general_news".
const CATEGORY_HINTS = [
  { category: 'weather', pattern: /\bweather\b/i },
  { category: 'finance', pattern: /\b(stock price|stock market|share price)\b/i },
  { category: 'sports', pattern: /\b(score|scores|game result|match result)\b/i },
  { category: 'current_affairs', pattern: /\b(current president|election|breaking)\b/i },
  { category: 'technology', pattern: /\b(current version|release today|new release)\b/i },
];

function guessCategory(message) {
  const hit = CATEGORY_HINTS.find(({ pattern }) => pattern.test(message));
  return hit ? hit.category : 'general_news';
}

function matchesFreshKeywords(normalized) {
  return FRESH_PHRASES.some(phrase => normalized.includes(phrase));
}

// ── STABLE-KNOWLEDGE PATTERNS ───────────────────────────
// Sentence starters / phrasings that are reliably timeless — definitions,
// explanations, coding requests, "who invented/created X" trivia, and
// classic CS topics. These never depend on "right now" and never need
// live search.
const STABLE_STARTERS = [
  /^(what is|what's|what are|what was|what were)\b/i,
  /^(who is|who's|who was)\b/i,
  /^who (created|invented|founded|wrote|made|built|designed)\b/i,
  /^(explain|describe|define)\b/i,
  /^how (does|do|did)\b.*\bwork\b/i,
  /^how to\b/i,
  /^(write|implement|create|build|generate|design|refactor|debug|fix)\b/i,
  /\bdifference between\b/i,
];

// Classic, evergreen CS/programming topics — asking about these ("bubble
// sort in C", "recursion") is stable knowledge even without a WH-starter.
const STABLE_TOPICS = /\b(bubble sort|quick ?sort|merge ?sort|insertion ?sort|selection ?sort|binary search|linked list|hash table|hash map|binary tree|recursion|big o notation)\b/i;

// A stable-looking sentence can still be a context-dependent follow-up if
// its subject is a pronoun ("what is he", "who is it") — that's not
// resolvable without conversation history, so it must defer to the
// planner rather than being answered as generic trivia.
const PRONOUN_SUBJECT = /^(he|him|his|she|her|hers|it|its|they|them|their|this|that|those|these)\b/i;

function matchesStableKnowledge(rawMessage, normalized) {
  if (STABLE_TOPICS.test(normalized)) return true;

  for (const starter of STABLE_STARTERS) {
    const match = rawMessage.match(starter);
    if (!match) continue;

    const remainder = rawMessage.slice(match[0].length).trim();
    if (PRONOUN_SUBJECT.test(remainder)) {
      // e.g. "what is he" / "who is it" — ambiguous, needs context.
      return false;
    }
    return true;
  }

  return false;
}

// ── FOLLOW-UP / AMBIGUITY SIGNALS ───────────────────────
// Short messages built around pronouns or state-change words ("still",
// "yet", "after that") almost always depend on prior conversation turns
// to resolve — these are exactly the cases Sprint 3.2 wants the planner
// (not Fast Path) to own. Fast Path doesn't try to resolve them; it just
// recognizes them as "not obvious" and defers.
const AMBIGUITY_SIGNALS = /\b(he|him|his|she|her|it|its|they|them|this|that)\b.*\b(still|yet|now|already|after that|anymore)\b|\b(still|yet|already|anymore)\b.*\b(he|him|his|she|her|it|its|they|them|this|that)\b/i;

function isDevLog() {
  return process.env.NODE_ENV !== 'production';
}

// Returns a Fast Path verdict:
//   { verdict: 'CHAT' | 'SEARCH' | 'DEFER', query, category, reason }
//
// verdict CHAT / SEARCH → SearchRouter returns immediately, planner never runs.
// verdict DEFER         → SearchRouter falls through to planner.planMessage().
export function classifyFastPath({ message, image }) {
  // Image detection: vision path is deterministic and never reaches text
  // routing at all (Fast Path or planner) — same behavior as before this
  // sprint, just now owned here so SearchRouter has one call site for all
  // deterministic bypass logic.
  if (image) {
    if (isDevLog()) console.log('[FastPath] CHAT (image attached — vision path)');
    return { verdict: 'CHAT', query: '', category: '', reason: 'image_attached' };
  }

  const normalized = (message || '').toLowerCase().trim();
  if (!normalized) {
    if (isDevLog()) console.log('[FastPath] DEFER → Planner (empty message)');
    return { verdict: 'DEFER', query: '', category: '', reason: 'empty_message' };
  }

  // Fresh-information keywords take priority over stable-looking phrasing —
  // e.g. "what is the latest iPhone" should still route SEARCH, not get
  // caught by the "what is" stable starter.
  if (matchesFreshKeywords(normalized)) {
    if (isDevLog()) console.log('[FastPath] SEARCH (fresh keywords)');
    return { verdict: 'SEARCH', query: message, category: guessCategory(normalized), reason: 'fresh_keywords' };
  }

  // Ambiguous follow-up shape ("is he still president", "has it released
  // yet") — never answered by Fast Path, always deferred so the planner
  // can use conversation history to resolve it.
  if (AMBIGUITY_SIGNALS.test(normalized)) {
    if (isDevLog()) console.log('[FastPath] DEFER → Planner (ambiguous follow-up)');
    return { verdict: 'DEFER', query: '', category: '', reason: 'ambiguous_followup' };
  }

  if (matchesStableKnowledge(message.trim(), normalized)) {
    if (isDevLog()) console.log('[FastPath] CHAT (stable knowledge)');
    return { verdict: 'CHAT', query: '', category: '', reason: 'stable_knowledge' };
  }

  if (isDevLog()) console.log('[FastPath] DEFER → Planner');
  return { verdict: 'DEFER', query: '', category: '', reason: 'ambiguous_request' };
}

export default { classifyFastPath };
