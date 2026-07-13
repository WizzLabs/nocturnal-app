// ─── CAPABILITY PLANNER ────────────────────────────────
// Decides whether a message can be answered directly (CHAT) or needs live
// information (SEARCH), using a small/fast LLM call instead of hardcoded
// keyword matching. This is deliberately a SEPARATE axis from the existing
// tier router (autoSelectMode in server.js, which picks flash/insight/abyss)
// — the two never need to know about each other.
//
// Sprint 8.1: output extended with "category" and "confidence" alongside
// route/query. category feeds the cache module's per-category TTL (see
// lib/search/cache.js — the two share the same category list so they can't
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

import { knownCategories } from './search/cache.js';

const ALLOWED_ROUTES = ['CHAT', 'SEARCH', 'CLARIFY'];

// Sourced from the cache module so the two never drift apart — adding a
// category only requires editing lib/search/cache.js's CATEGORY_TTL_MS.
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

  return `You are a routing classifier for an AI assistant named Nocturnal, created by a developer named Wizz. Given the user's latest message and recent conversation context, decide how it should be handled.

Today's date is ${currentDateString}. This is injected fresh from the server clock and is always authoritative — never question it or treat it as being "in the future," and always resolve relative expressions ("today", "yesterday", "this week", "this month", "this year", "current", "latest") against this exact date. For example, if today's date is in 2026 and the user asks about "sports this year", the query should target 2026, not any earlier year from training data.

Note: plain local time/date requests (e.g. "what time is it", "what's today's date", "what day is it") are already handled before this planner ever runs and will not reach you — you don't need a route for them.

Respond with ONLY a JSON object, no other text, no markdown fences:
{"route": "CHAT" | "SEARCH" | "CLARIFY", "query": "<standalone search query, only if route is SEARCH, else empty string>", "category": "<one of: ${CATEGORIES.join(', ')}, general_news, or empty string if route is not SEARCH>", "confidence": <number 0 to 1, how confident you are in this route decision>, "clarify": "<a short clarifying question, only if route is CLARIFY, else empty string>"}

Step 1 — context-first check (do this before considering SEARCH at all):
Can this already be answered using (a) the assistant's own identity/features/creator, (b) the current conversation, or (c) stable model knowledge? If yes, the answer is CHAT, full stop — never SEARCH, no matter how the question is phrased. This covers questions about the assistant itself (who made it, what it's called, what it can do, its modes/personality/features), questions about what's already been said in this session, and anything answerable from general knowledge that doesn't go stale.

Step 2 — breadth check (only if step 1 didn't resolve it):
If the request is genuinely current/real-world but too broad or vague to search usefully (no clear topic, timeframe, or subject — e.g. "what happened this year", "tell me about AI", "anything new?"), route CLARIFY instead of guessing a search query. Ask one short, specific question that would narrow it down enough to search well. Never route CLARIFY for something answerable under step 1.

Step 3 — route the rest:
- route "SEARCH": the message needs current, live, or real-world factual information the model cannot reliably know from training — current events, current holders of a role/position, prices, scores, recent releases, specific real people/entities/products that are obscure or recent, "what year/date is it", or anything explicitly about "now"/"current"/"latest"/"today" — AND it's specific enough to form a real query.
- route "CHAT": everything else — coding help, explanations of stable concepts, creative writing, math, opinions, general knowledge that doesn't change, conversation, follow-ups answerable from context already given, and anything about the assistant's own identity or this session.
- Default to CHAT when uncertain. Only choose SEARCH when live information would genuinely change the answer and the topic is concrete enough to search for.
- If route is SEARCH, "query" must be a short, standalone, self-contained, normalized search query — resolve pronouns/references from conversation context, and rewrite vague phrasing into what you'd actually type into a search engine (e.g. "what year is it" becomes "current date", not a literal copy of the question).
- If route is SEARCH, "category" should be your best single-word fit from the list above — pick the closest match, don't overthink it.
- "confidence" reflects how sure you are about the ROUTE choice, not the answer itself. Use lower confidence for ambiguous or borderline cases.

Examples:
"explain recursion" -> {"route":"CHAT","query":"","category":"","confidence":0.98,"clarify":""}
"who is your creator" -> {"route":"CHAT","query":"","category":"","confidence":0.98,"clarify":""}
"who is Wizz" -> {"route":"CHAT","query":"","category":"","confidence":0.97,"clarify":""}
"what is Nocturnal" -> {"route":"CHAT","query":"","category":"","confidence":0.98,"clarify":""}
"what are your modes" -> {"route":"CHAT","query":"","category":"","confidence":0.97,"clarify":""}
"what can you do" -> {"route":"CHAT","query":"","category":"","confidence":0.97,"clarify":""}
"what do you know about me" -> {"route":"CHAT","query":"","category":"","confidence":0.95,"clarify":""}
"who is the current president of France" -> {"route":"SEARCH","query":"current president of France","category":"current_affairs","confidence":0.95,"clarify":""}
"write a poem about the ocean" -> {"route":"CHAT","query":"","category":"","confidence":0.98,"clarify":""}
"what's the weather like in Tokyo right now" -> {"route":"SEARCH","query":"weather in Tokyo right now","category":"weather","confidence":0.97,"clarify":""}
"review this code for bugs" -> {"route":"CHAT","query":"","category":"","confidence":0.97,"clarify":""}
"who is NanduTaT" -> {"route":"SEARCH","query":"who is NanduTaT","category":"public_figures","confidence":0.8,"clarify":""}
"how's the stock market doing today" -> {"route":"SEARCH","query":"stock market today","category":"finance","confidence":0.95,"clarify":""}
"did the lakers win last night" -> {"route":"SEARCH","query":"lakers game result last night","category":"sports","confidence":0.95,"clarify":""}
"who won yesterday" -> {"route":"SEARCH","query":"yesterday match result","category":"sports","confidence":0.85,"clarify":""}
"latest iphone" -> {"route":"SEARCH","query":"latest Apple iPhone release","category":"technology","confidence":0.9,"clarify":""}
"sports this year" -> {"route":"SEARCH","query":"sports news ${currentYearHint}","category":"sports","confidence":0.85,"clarify":""}
"do you know anything that happened in 2026" -> {"route":"CLARIFY","query":"","category":"","confidence":0.85,"clarify":"Are you thinking of a particular topic — like technology, politics, sports, or entertainment?"}
"what happened this year" -> {"route":"CLARIFY","query":"","category":"","confidence":0.85,"clarify":"Anything in particular — world news, tech, sports, something else?"}
"tell me about AI" -> {"route":"CLARIFY","query":"","category":"","confidence":0.8,"clarify":"There's a lot there — are you curious about how AI works, recent AI news, or something specific?"}`;
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

function safeParsePlannerOutput(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip accidental markdown fences defensively — the prompt forbids them,
  // but small/fast models occasionally add them anyway.
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!ALLOWED_ROUTES.includes(parsed.route)) return null;

    const confidence = typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 1; // if the model omits confidence, don't penalize — assume default trust

    return {
      route: parsed.route,
      query: typeof parsed.query === 'string' ? parsed.query.trim() : '',
      category: typeof parsed.category === 'string' && parsed.category.trim()
        ? parsed.category.trim()
        : 'general_news',
      confidence,
      clarify: typeof parsed.clarify === 'string' ? parsed.clarify.trim() : '',
    };
  } catch {
    return null;
  }
}

// Runs the planner call. Fails CLOSED to { route: 'CHAT' } on any error —
// a planner failure must never break the chat pipeline.
//
// Params:
//   groqClient   - Groq client instance (always the shared default client,
//                  never a user's BYOK client — planner behavior/cost
//                  should not depend on whether a user has their own key)
//   plannerModel - model string to use for the planner call
//   message      - the current user message
//   history      - recent conversation history (array of {role, content}),
//                  already trimmed by the caller to a short window
export async function planMessage({ groqClient, plannerModel, message, history, currentDateString }) {
  try {
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // planner must be fast

    let completion;
    try {
      completion = await groqClient.chat.completions.create(
        {
          model: plannerModel,
          messages: [
            { role: 'system', content: plannerSystemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
          max_completion_tokens: 200,
        },
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timeoutId);
    }

    const raw = completion.choices[0]?.message?.content || '';
    const parsed = safeParsePlannerOutput(raw);

    if (!parsed) {
      console.warn('Planner returned unparseable output, defaulting to CHAT:', raw.slice(0, 200));
      return { route: 'CHAT', query: '', category: '', confidence: 0, clarify: '' };
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
      return { route: 'CHAT', query: '', category: '', confidence: parsed.confidence, clarify: '' };
    }

    // Confidence threshold: a low-confidence SEARCH call is downgraded to
    // CHAT rather than spending a search on a shaky guess. See
    // SEARCH_CONFIDENCE_THRESHOLD above for rationale.
    if (parsed.route === 'SEARCH' && parsed.confidence < SEARCH_CONFIDENCE_THRESHOLD) {
      console.log(`[Planner] SEARCH (low confidence ${parsed.confidence.toFixed(2)} < ${SEARCH_CONFIDENCE_THRESHOLD}, downgraded to CHAT)`);
      return { route: 'CHAT', query: '', category: '', confidence: parsed.confidence, clarify: '' };
    }

    console.log(`[Planner] ${parsed.route}${parsed.route === 'SEARCH' ? ` (${parsed.category}, confidence ${parsed.confidence.toFixed(2)})` : parsed.route === 'CLARIFY' ? ` (confidence ${parsed.confidence.toFixed(2)})` : ''}`);
    return parsed;
  } catch (err) {
    console.warn('Planner call failed, defaulting to CHAT:', err.message);
    return { route: 'CHAT', query: '', category: '', confidence: 0, clarify: '' };
  }
}
