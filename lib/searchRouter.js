// ─── SEARCH ROUTER ──────────────────────────────────────
// Sprint 3: single responsibility module that decides WHETHER Search should
// run for a given /chat request. This is the ONLY place that decision is
// made — server.js no longer branches on `mode === 'auto'` to gate the
// planner, and SearchService itself never decides when to run, only how.
//
//   server.js → SearchRouter.route() → { CHAT | SEARCH | CLARIFY }
//                      │
//                      ▼ (SEARCH only)
//               SearchService.search()
//
// Why this exists as its own module instead of inline in server.js:
// Sprint 2 made Search provider-independent. Sprint 3 makes the DECISION to
// search independent of the user's reasoning tier (flash/insight/abyss) —
// previously the planner (and therefore Search) only ran for Auto mode, so
// manual modes could never get live context. Search is a capability that
// sits ABOVE mode selection, not inside it:
//
//   Flash   ↓ Search (if required) ↓ Flash model
//   Insight ↓ Search (if required) ↓ Insight model
//   Abyss   ↓ Search (if required) ↓ Abyss model
//   Auto    ↓ Search (if required) ↓ auto-selected model
//
// The user's selected mode is NEVER touched or overridden by this module —
// it only returns a routing decision; server.js still owns mode resolution
// entirely on its own.
//
// This module wraps lib/planner.js (the LLM-based classifier from Sprint
// 8.1/8.5) rather than reintroducing keyword matching at this layer — the
// planner remains the conversation-aware classifier for anything genuinely
// ambiguous. What Sprint 3.2 changes is WHEN the planner runs: a new
// deterministic Fast Path stage (lib/fastPathRouter.js) is consulted first,
// and the planner is only invoked when Fast Path can't confidently decide.
// SearchRouter is still the single call site — server.js is unaware that
// Fast Path exists at all, same as it was unaware of keyword matching
// before.
//
//   SearchRouter.routeSearchDecision()
//         |
//         v
//   FastPathRouter.classify()  (no LLM, no API call - microseconds)
//     |        |         |
//   CHAT   SEARCH      DEFER
//     |        |         |
//     |        |         v
//     |        |   planner.planMessage()  (LLM call, conversation-aware)
//     v        v
//   normalized routing decision returned to server.js

import { planMessage } from './planner.js';
import { classifyFastPath } from './fastPathRouter.js';
import { resolveQuery, recordEntityFromMessage } from './contextResolver.js';

// Runs Fast Path first, and only falls through to the capability planner
// when Fast Path defers. Never throws — planMessage() already fails closed
// to CHAT on any error, and Fast Path never throws by construction (pure
// deterministic checks, no I/O).
//
// Params mirror planMessage()'s, plus:
//   image     — if truthy, routing is skipped entirely (vision path, decided
//               deterministically by Fast Path)
//   sessionId — Sprint 3.3: scopes the Conversation Entity Store
//               (lib/entityStore.js) so pronoun follow-ups ("what's the
//               latest version of it") can be resolved against the last
//               entity mentioned in THIS conversation. Optional — if
//               omitted, context resolution silently no-ops and behavior
//               is identical to before this sprint.
//
// Returns:
//   { route: 'CHAT' | 'SEARCH' | 'CLARIFY', query, category, confidence, clarify }
export async function routeSearchDecision({ aiClient, plannerModel, message, history, currentDateString, image, sessionId }) {
  const isDev = process.env.NODE_ENV !== 'production';

  const fastPath = classifyFastPath({ message, image });

  // Sprint 3.3: record whatever entity this message introduces (if any)
  // BEFORE routing, regardless of verdict — a stable-knowledge CHAT
  // message like "Who created Python?" must seed the entity store just
  // as much as a SEARCH does, since it's the one that later pronoun
  // follow-ups ("what's the latest version of it") will resolve against.
  // Never overwrites the store with nothing — extraction is best-effort
  // and no-ops silently when it finds no confident subject.
  if (!image) {
    recordEntityFromMessage({ sessionId, message });
  }

  if (fastPath.verdict === 'CHAT') {
    return { route: 'CHAT', query: '', category: '', confidence: 1, reason: fastPath.reason, clarify: '' };
  }

  if (fastPath.verdict === 'SEARCH') {
    // Sprint 3.3: Fast Path's SEARCH verdict is a raw keyword match (e.g.
    // "latest") — it has no conversation awareness, so a follow-up like
    // "what's the latest version of it" would otherwise be sent to Search
    // verbatim, pronoun and all. Resolve it deterministically here before
    // it ever leaves SearchRouter.
    const { resolvedQuery, wasResolved } = resolveQuery({ query: fastPath.query, sessionId });
    if (isDev && wasResolved) {
      console.log(`[SearchRouter] Context Resolver: "${fastPath.query}" → "${resolvedQuery}"`);
    }
    return { route: 'SEARCH', query: resolvedQuery, category: fastPath.category, confidence: 0.9, reason: 'fresh_information', clarify: '' };
  }

  // fastPath.verdict === 'DEFER' — routing is genuinely ambiguous or
  // context-dependent (e.g. "is he still president?"), so fall through to
  // the conversation-aware planner exactly as before this sprint.
  const decision = await planMessage({ aiClient, plannerModel, message, history, currentDateString });

  // Sprint 3.3: the planner is instructed to already return a standalone
  // query, and usually does — but it's an LLM call, not a guarantee. Run
  // the same deterministic resolver as a safety net so a leftover pronoun
  // never reaches Search just because the planner missed one.
  if (decision.route === 'SEARCH' && decision.query) {
    const { resolvedQuery, wasResolved } = resolveQuery({ query: decision.query, sessionId });
    if (wasResolved) {
      if (isDev) console.log(`[SearchRouter] Context Resolver (planner safety net): "${decision.query}" → "${resolvedQuery}"`);
      decision.query = resolvedQuery;
    }
  }

  if (isDev) {
    if (decision.route === 'SEARCH') {
      console.log(`[SearchRouter] Search requested — category="${decision.category}", confidence=${decision.confidence.toFixed(2)}, reason=${decision.reason}`);
    } else if (decision.route === 'CLARIFY') {
      console.log(`[SearchRouter] Search deferred — clarification needed (reason=${decision.reason})`);
    } else {
      console.log(`[SearchRouter] Search skipped (reason=${decision.reason})`);
    }
  }

  return decision;
}

export default { routeSearchDecision };
