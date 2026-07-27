// ─── CAPABILITY PLANNER ────────────────────────────────
// Decides whether a message can be answered directly (CHAT) or needs live
// information (SEARCH), using a small/fast LLM call instead of hardcoded
// keyword matching. This is deliberately a SEPARATE axis from the existing
// tier router (autoSelectMode in server.js, which picks flash/insight/abyss)
// — the two never need to know about each other.
//
// Sprint 8.1: output extended with "category" and "confidence" alongside
// route/query. category feeds the cache module's per-category TTL (see
// services/search/cache.js — the two share the same category list so they can't
// drift apart) and confidence is used here to downgrade shaky SEARCH calls
// back to CHAT before they ever reach the cache/search layer. Callers
// (server.js) never need to reason about either field beyond passing
// category through to the cache — all threshold/TTL logic stays local to
// the module that owns it.
//
// Extending later: to add DOCUMENT, TOOLS, etc., add the route name to
// ALLOWED_ROUTES and the enum in the prompt below, then branch on the new
// route in server.js. Nothing here else needs to change. Image/VISION
// routing is intentionally NOT handled by this planner — the existing
// image-attached check in /chat runs before this and short-circuits
// straight to the flash vision model, since that decision is deterministic
// (an image either is or isn't attached) and doesn't need a model call.

import { knownCategories } from '../services/search/cache.js';

const ALLOWED_ROUTES = ['CHAT', 'SEARCH', 'CLARIFY'];

// Sourced from the cache module so the two never drift apart — adding a
// category only requires editing services/search/cache.js's CATEGORY_TTL_MS.
const CATEGORIES = knownCategories().filter(c => c !== 'default');

// Sprint 8.5: gained a "CLARIFY" route and an explicit context-first check.
// The SEARCH/CHAT contract is unchanged — CLARIFY just reuses the same
// object shape with a new "clarify" field, so server.js only needs one new
// branch, not a rewrite.
// Sprint 8.5.1: takes the authoritative, server-clock current date so the
// planner resolves relative expressions ("this year", "today", "latest")
// against the real date instead of guessing from training data, and never
// treats the injected date itself as implausible. currentDateString is
// computed fresh per-request by the caller (server.js) — never hardcoded
// here.
function buildPlannerSystemPrompt(currentDateString) {
  // Best-effort year extraction purely for the "sports this year" example
  // below — falls back to the browser/runtime's own current year if the
  // caller's date string doesn't parse cleanly for any reason.
  const yearMatch = typeof currentDateString === 'string' && currentDateString.match(/\d{4}/);
  const currentYearHint = yearMatch ? yearMatch[0] : String(new Date().getFullYear());

  return `You are a routing classifier. Your entire response must be exactly one JSON object — nothing before it, nothing after it. No reasoning. No explanation. No preamble. No markdown. No code fences. No <think> blocks. Just the JSON object.

You are classifying messages for an AI assistant named Nocturnal, built by a developer named Wizz. Today's date is ${currentDateString} (authoritative server clock value — never question it, never call it future-dated). Resolve all relative time expressions ("today", "yesterday", "this week", "this month", "this year", "current", "latest", "now") against this exact date. Plain time/date requests are handled before you and will not reach you.

Output schema — one JSON object, exactly this shape:
{"route": "CHAT" | "SEARCH" | "CLARIFY", "query": "<standalone search query if SEARCH, else empty string>", "category": "<one of: ${CATEGORIES.join(', ')}, general_news — only if SEARCH, else empty string>", "confidence": <0.0–1.0>, "reason": "<one of: stable_knowledge, fresh_information, follow_up, ambiguous_request>", "clarify": "<one short clarifying question if CLARIFY, else empty string>"}

Reason field guide (internal/debugging only, never shown to the user):
- stable_knowledge: CHAT because the answer is timeless/general knowledge or about Nocturnal itself.
- follow_up: CHAT because the answer is resolvable from the recent conversation shown to you.
- fresh_information: SEARCH because current/live/real-world information is genuinely required.
- ambiguous_request: CLARIFY because the request is too vague to form a useful search query.

Routing rules:

Step 1 — context-first (highest priority):
If answerable from (a) the assistant's own identity, features, or creator, (b) this conversation, or (c) stable general knowledge — route CHAT. This covers who built Nocturnal, what it can do, its modes, anything already said in the session, and concepts that don't change over time. Never route SEARCH for these.

Step 2 — too broad to search:
If the message genuinely needs live information but is too vague to form a useful query (e.g. "what happened this year", "anything new?") — route CLARIFY. Provide one short question in "clarify" that would narrow it enough to search. Never CLARIFY something Step 1 already resolves.

Step 3 — route the rest:
SEARCH: needs current, live, or real-world info the model can't reliably know — current events, who holds a position now, prices, scores, recent releases, obscure entities — AND specific enough to query.
CHAT: everything else — code, explanations, creative writing, math, opinions, stable knowledge, follow-ups from context.
Default to CHAT when uncertain.

Examples:
"explain recursion" -> {"route":"CHAT","query":"","category":"","confidence":0.98,"reason":"stable_knowledge","clarify":""}
"who is your creator" -> {"route":"CHAT","query":"","category":"","confidence":0.98,"reason":"stable_knowledge","clarify":""}
"who is Wizz" -> {"route":"CHAT","query":"","category":"","confidence":0.97,"reason":"stable_knowledge","clarify":""}
"what is Nocturnal" -> {"route":"CHAT","query":"","category":"","confidence":0.98,"reason":"stable_knowledge","clarify":""}
"what are your modes" -> {"route":"CHAT","query":"","category":"","confidence":0.97,"reason":"stable_knowledge","clarify":""}
"what can you do" -> {"route":"CHAT","query":"","category":"","confidence":0.97,"reason":"stable_knowledge","clarify":""}
"who is the current president of France" -> {"route":"SEARCH","query":"current president of France","category":"current_affairs","confidence":0.95,"reason":"fresh_information","clarify":""}
"write a poem about the ocean" -> {"route":"CHAT","query":"","category":"","confidence":0.98,"reason":"stable_knowledge","clarify":""}
"what's the weather like in Tokyo right now" -> {"route":"SEARCH","query":"weather in Tokyo right now","category":"weather","confidence":0.97,"reason":"fresh_information","clarify":""}
"review this code for bugs" -> {"route":"CHAT","query":"","category":"","confidence":0.97,"reason":"stable_knowledge","clarify":""}
"who is NanduTaT" -> {"route":"SEARCH","query":"who is NanduTaT","category":"public_figures","confidence":0.8,"reason":"fresh_information","clarify":""}
"how's the stock market doing today" -> {"route":"SEARCH","query":"stock market today","category":"finance","confidence":0.95,"reason":"fresh_information","clarify":""}
"did the lakers win last night" -> {"route":"SEARCH","query":"lakers game result last night","category":"sports","confidence":0.95,"reason":"fresh_information","clarify":""}
"latest iphone" -> {"route":"SEARCH","query":"latest Apple iPhone release","category":"technology","confidence":0.9,"reason":"fresh_information","clarify":""}
"sports this year" -> {"route":"SEARCH","query":"sports news ${currentYearHint}","category":"sports","confidence":0.85,"reason":"fresh_information","clarify":""}
"do you know anything that happened in 2026" -> {"route":"CLARIFY","query":"","category":"","confidence":0.85,"reason":"ambiguous_request","clarify":"Are you thinking of a particular topic — like technology, politics, sports, or entertainment?"}
"what happened this year" -> {"route":"CLARIFY","query":"","category":"","confidence":0.85,"reason":"ambiguous_request","clarify":"Anything in particular — world news, tech, sports, something else?"}
"tell me about AI" -> {"route":"CLARIFY","query":"","category":"","confidence":0.8,"reason":"ambiguous_request","clarify":"There's a lot there — are you curious about how AI works, recent AI news, or something specific?"}
"what does he do" (after a prior message about a person) -> {"route":"CHAT","query":"","category":"","confidence":0.9,"reason":"follow_up","clarify":""}
"what GPUs were announced" (after a prior NVIDIA news search in this conversation) -> {"route":"CHAT","query":"","category":"","confidence":0.85,"reason":"follow_up","clarify":""}`;
}

// Below this, the planner itself isn't confident SEARCH is the right call —
// downgrading to CHAT here (rather than in server.js) keeps the threshold
// decision co-located with the rest of the planner's judgment calls, and
// means callers never need to know a threshold exists at all. 0.55 was
// chosen as a middle ground: high enough to skip genuinely shaky guesses,
// low enough not to suppress legitimate-but-uncertain live-info calls
// (e.g. an obscure name the planner recognizes as "probably needs search"
// but isn't fully sure about).
const SEARCH_CONFIDENCE_THRESHOLD = 0.55;

const VALID_REASONS = ['stable_knowledge', 'fresh_information', 'follow_up', 'ambiguous_request'];

// Best-effort defaulting when the model omits/mangles the reason field —
// never blocks a decision on a missing reason, since reason is diagnostic
// only and must never gate routing behavior.
function normalizeReason(rawReason, route) {
  if (typeof rawReason === 'string' && VALID_REASONS.includes(rawReason.trim())) {
    return rawReason.trim();
  }
  if (route === 'SEARCH') return 'fresh_information';
  if (route === 'CLARIFY') return 'ambiguous_request';
  return 'stable_knowledge';
}

function parseJsonCandidate(text) {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}

// Attempts a normal parse first; on failure, tries to recover by extracting
// the first {...} block from the raw text (handles cases where the model
// wraps valid JSON in stray prose despite instructions not to). Returns
// { parsed, recovered } or null if both attempts fail.
function safeParsePlannerOutput(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let parsedRaw;
  let recovered = false;
  try {
    parsedRaw = parseJsonCandidate(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsedRaw = parseJsonCandidate(match[0]);
      recovered = true;
    } catch {
      return null;
    }
  }

  if (!ALLOWED_ROUTES.includes(parsedRaw.route)) return null;

  const confidence = typeof parsedRaw.confidence === 'number' && parsedRaw.confidence >= 0 && parsedRaw.confidence <= 1
    ? parsedRaw.confidence
    : 1; // if the model omits confidence, don't penalize — assume default trust

  const parsed = {
    route: parsedRaw.route,
    query: typeof parsedRaw.query === 'string' ? parsedRaw.query.trim() : '',
    category: typeof parsedRaw.category === 'string' && parsedRaw.category.trim()
      ? parsedRaw.category.trim()
      : 'general_news',
    confidence,
    reason: normalizeReason(parsedRaw.reason, parsedRaw.route),
    clarify: typeof parsedRaw.clarify === 'string' ? parsedRaw.clarify.trim() : '',
  };

  return { parsed, recovered };
}

const CHAT_FALLBACK = { route: 'CHAT', query: '', category: '', confidence: 0, reason: 'stable_knowledge', clarify: '' };

const isDevLog = () => process.env.NODE_ENV !== 'production';

// Single raw model call + parse attempt. Does not catch network/timeout
// errors — those propagate to the caller, which decides whether to retry.
// Returns { parsed, recovered, raw } on success or { parsed: null, raw } on
// a parse failure (caller decides whether to retry or fall back).
async function attemptPlannerCall({ aiClient, plannerModel, plannerSystemPrompt, userPrompt, attemptLabel }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000); // planner must be fast

  let completion;
  try {
    completion = await aiClient.chatComplete({
      model: plannerModel,
      messages: [
        { role: 'system', content: plannerSystemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      maxTokens: 200,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const raw = completion.choices[0]?.message?.content || '';
  if (isDevLog()) console.log(`[Planner] ${attemptLabel} raw response: ${raw.slice(0, 300)}`);

  const result = safeParsePlannerOutput(raw);
  if (!result) {
    console.warn(`[Planner] ${attemptLabel} parse failed:`, raw.slice(0, 200));
    return { parsed: null, raw };
  }

  if (result.recovered && isDevLog()) {
    console.log(`[Planner] ${attemptLabel} parsed via safe-recovery (extracted JSON from surrounding text)`);
  }

  return { parsed: result.parsed, raw };
}

// Runs the planner call. Fails CLOSED to { route: 'CHAT' } on any error —
// a planner failure must never break the chat pipeline.
//
// Reliability strategy (Sprint 3.1):
//   1. Call the planner once.
//   2. If the response fails to parse, try safe recovery (extract the
//      first {...} block from the raw text) before giving up on it.
//   3. If it's still unparseable, retry the planner call ONCE more.
//   4. If the retry also fails, fall back to CHAT and log why.
// Every step is logged (dev-only) so routing failures are diagnosable
// without silently masking why SEARCH was downgraded to CHAT.
//
// Params:
//   aiClient     - AI provider client (see lib/providers/index.js), always
//                  the shared default client, never a user's BYOK client —
//                  planner behavior/cost should not depend on whether a
//                  user has their own key
//   plannerModel - model string to use for the planner call
//   message      - the current user message
//   history      - recent conversation history (array of {role, content}),
//                  already trimmed by the caller to a short window
export async function planMessage({ aiClient, plannerModel, message, history, currentDateString }) {
  const plannerSystemPrompt = buildPlannerSystemPrompt(
    currentDateString || new Date().toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    })
  );

  const recentHistory = Array.isArray(history) ? history.slice(-4) : [];
  const historyText = recentHistory
    .map(item => `${item.role === 'ai' ? 'assistant' : 'user'}: ${item.content}`)
    .join('\n');

  const userPrompt = historyText
    ? `Recent conversation:\n${historyText}\n\nLatest message: ${message}`
    : `Latest message: ${message}`;

  let parsed = null;
  let usedRetry = false;

  try {
    const first = await attemptPlannerCall({ aiClient, plannerModel, plannerSystemPrompt, userPrompt, attemptLabel: 'attempt 1' });
    parsed = first.parsed;

    if (!parsed) {
      console.warn('[Planner] retrying once after unparseable response');
      usedRetry = true;
      const second = await attemptPlannerCall({ aiClient, plannerModel, plannerSystemPrompt, userPrompt, attemptLabel: 'attempt 2 (retry)' });
      parsed = second.parsed;
    }
  } catch (err) {
    // Network/timeout/provider error — never thrown from here, fail closed.
    console.warn('Planner call failed, defaulting to CHAT:', err.message);
    return { ...CHAT_FALLBACK, reason: 'stable_knowledge' };
  }

  if (!parsed) {
    console.warn('[Planner] both attempts unparseable, defaulting to CHAT');
    return { ...CHAT_FALLBACK, reason: 'ambiguous_request' };
  }

  if (usedRetry) {
    // Diagnostic-only tag: this decision only exists because attempt 1
    // failed to parse. Does not change route/confidence, only visibility.
    parsed.reason = 'planner_retry';
  }

  if (parsed.route === 'SEARCH' && !parsed.query) {
    // Guard against a SEARCH route with an empty query — fall back to
    // the raw message rather than sending an empty string to the search API.
    parsed.query = message;
  }

  // Guard against a CLARIFY route with no question to ask — a CLARIFY
  // route is useless without one, so fall back to CHAT rather than
  // silently doing nothing.
  if (parsed.route === 'CLARIFY' && !parsed.clarify) {
    console.log('[Planner] CLARIFY with empty question, downgraded to CHAT');
    return { route: 'CHAT', query: '', category: '', confidence: parsed.confidence, reason: parsed.reason, clarify: '' };
  }

  // Confidence threshold: a low-confidence SEARCH call is downgraded to
  // CHAT rather than spending a search on a shaky guess. See
  // SEARCH_CONFIDENCE_THRESHOLD above for rationale.
  if (parsed.route === 'SEARCH' && parsed.confidence < SEARCH_CONFIDENCE_THRESHOLD) {
    console.log(`[Planner] SEARCH (low confidence ${parsed.confidence.toFixed(2)} < ${SEARCH_CONFIDENCE_THRESHOLD}, downgraded to CHAT)`);
    return { route: 'CHAT', query: '', category: '', confidence: parsed.confidence, reason: parsed.reason, clarify: '' };
  }

  console.log(`[Planner] final decision: ${parsed.route}${parsed.route === 'SEARCH' ? ` (${parsed.category}, confidence ${parsed.confidence.toFixed(2)})` : parsed.route === 'CLARIFY' ? ` (confidence ${parsed.confidence.toFixed(2)})` : ''} [reason: ${parsed.reason}]`);
  return parsed;
}
