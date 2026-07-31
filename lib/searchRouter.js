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

import { planMessage, applyDocumentContext } from './planner.js';
import { classifyFastPath } from './fastPathRouter.js';
import { resolveQuery, recordEntityFromMessage } from './contextResolver.js';

// Schema fields every return path should carry, even ones that never
// touch the Entity Store directly (forceSearch/FastPath already resolve
// pronouns via ContextResolver above, but don't compute a numeric
// memory_relevance) — kept at safe defaults there rather than omitted,
// so every caller sees the same shape regardless of which stage decided.
const SCHEMA_DEFAULTS = { topic: '', memory_relevance: 0, entity_used: '' };

// Runs Fast Path first, and only falls through to the capability planner
// when Fast Path defers. Never throws — planMessage() already fails closed
// to CHAT on any error, and Fast Path never throws by construction (pure
// deterministic checks, no I/O).
//
// Params mirror planMessage()'s, plus:
//   image           — if truthy, routing is skipped entirely (vision path,
//                      decided deterministically by Fast Path)
//   sessionId       — Sprint 3.3: scopes the Conversation Entity Store
//                      (lib/entityStore.js) so pronoun follow-ups ("what's
//                      the latest version of it") can be resolved against
//                      the last entity mentioned in THIS conversation.
//                      Optional — if omitted, context resolution silently
//                      no-ops and behavior is identical to before Sprint 3.3.
//   documentContext — Sprint 8A.5: the session's cached document (if any —
//                      services/document/context.js shape), scored via
//                      Planner V2's applyDocumentContext() against EVERY
//                      routing path below (not just the LLM planner path),
//                      so DOCUMENT/HYBRID can be selected regardless of
//                      whether Fast Path or the full planner made the base
//                      call. Optional — omitted means document_relevance
//                      is always 0 and route is never upgraded, identical
//                      to pre-8A.5 behavior.
//
// Returns:
//   { route: 'CHAT'|'SEARCH'|'CLARIFY'|'DOCUMENT'|'HYBRID', query, category,
//     confidence, reason, clarify, topic, document_relevance,
//     memory_relevance, entity_used }
export async function routeSearchDecision({ aiClient, plannerModel, message, history, currentDateString, image, sessionId, forceSearch, documentContext }) {
  const isDev = process.env.NODE_ENV !== 'production';

  // Sprint 7 — Objective 7: Manual Search Mode. When the user has the
  // search toggle on, every message searches — Fast Path and the planner
  // never run at all, so this coexists cleanly with automatic routing
  // rather than replacing it (it's just a higher-priority bypass, same
  // pattern as the image check below). Still defers to the deterministic
  // vision path when an image is attached — Vision and Search remain
  // independent capabilities, and forcing search on an image-attached
  // request would fight the Vision Router rather than complement it.
  if (forceSearch && !image) {
    recordEntityFromMessage({ sessionId, message });
    const { resolvedQuery, wasResolved, entity } = resolveQuery({ query: message, sessionId });
    if (isDev) {
      console.log(`[SearchRouter] Manual search mode — forcing SEARCH${wasResolved ? ` (resolved: "${message}" → "${resolvedQuery}")` : ''}`);
    }
    const base = { route: 'SEARCH', query: resolvedQuery, category: 'general_news', confidence: 1, reason: 'manual_override', clarify: '', search_needed: true };
    return {
      ...SCHEMA_DEFAULTS,
      ...applyDocumentContext(base, { message, documentContext }),
      search_needed: true,
      // Bug fix (found during Sprint 8A.6 evaluation): resolveQuery()
      // already resolves the pronoun into resolvedQuery above — it was
      // being thrown away here instead of populating the schema's own
      // memory_relevance/entity_used fields. 0.75 matches the same
      // "resolution succeeded" confidence band planner.js's
      // computeMemorySignal() uses, so the two call sites can never
      // report different confidence for the same kind of evidence.
      ...(wasResolved ? { memory_relevance: 0.75, entity_used: entity } : {}),
    };
  }

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
    const base = { route: 'CHAT', query: '', category: '', confidence: 1, reason: fastPath.reason, clarify: '', search_needed: false };
    return { ...SCHEMA_DEFAULTS, ...applyDocumentContext(base, { message, documentContext }), search_needed: false };
  }

  if (fastPath.verdict === 'SEARCH') {
    // Sprint 3.3: Fast Path's SEARCH verdict is a raw keyword match (e.g.
    // "latest") — it has no conversation awareness, so a follow-up like
    // "what's the latest version of it" would otherwise be sent to Search
    // verbatim, pronoun and all. Resolve it deterministically here before
    // it ever leaves SearchRouter.
    const { resolvedQuery, wasResolved, entity } = resolveQuery({ query: fastPath.query, sessionId });
    if (isDev && wasResolved) {
      console.log(`[SearchRouter] Context Resolver: "${fastPath.query}" → "${resolvedQuery}"`);
    }
    const base = { route: 'SEARCH', query: resolvedQuery, category: fastPath.category, confidence: 0.9, reason: 'fresh_information', clarify: '', search_needed: true };
    return {
      ...SCHEMA_DEFAULTS,
      ...applyDocumentContext(base, { message, documentContext }),
      search_needed: true,
      // Same bug fix as the forceSearch branch above.
      ...(wasResolved ? { memory_relevance: 0.75, entity_used: entity } : {}),
    };
  }

  // fastPath.verdict === 'DEFER' — routing is genuinely ambiguous or
  // context-dependent (e.g. "is he still president?"), so fall through to
  // the conversation-aware planner exactly as before this sprint.
  // Sprint 8A.4/8A.5: sessionId AND documentContext are passed through so
  // the planner's own finalizeDecision() applies the document overlay and
  // populates memory_relevance/entity_used for real — this path already
  // returns the fully-overlaid decision, so it must NOT be re-wrapped in
  // applyDocumentContext below (that would double-apply the overlay).
  //
  // Sprint 8A.7 fix — Pronoun Resolution: previously the RAW message (with
  // the pronoun still in it, e.g. "what is his last movie?") was handed to
  // the planner's LLM call. The planner only ever sees a short history
  // window and has no access to the Entity Store, so it would frequently
  // just drop the unresolved pronoun in its own generated `query`
  // ("what is the last movie?") instead of inserting the real entity — and
  // once the entity is gone from `decision.query`, the "safety net" below
  // (which only fires when a pronoun is STILL present) has nothing left to
  // catch. Resolving the message here, before it ever reaches the LLM,
  // means the planner sees "what is Vijay's last movie?" in the first
  // place, so the entity survives query generation instead of depending on
  // the LLM to have preserved something it was never shown.
  const { resolvedQuery: resolvedMessage, wasResolved: messageWasResolved } = resolveQuery({ query: message, sessionId });
  if (isDev && messageWasResolved) {
    console.log(`[SearchRouter] Context Resolver (pre-planner): "${message}" → "${resolvedMessage}"`);
  }
  const decision = await planMessage({ aiClient, plannerModel, message: resolvedMessage, history, currentDateString, sessionId, documentContext });

  // Sprint 3.3: the planner is instructed to already return a standalone
  // query, and usually does — but it's an LLM call, not a guarantee. Run
  // the same deterministic resolver as a safety net so a leftover pronoun
  // never reaches Search just because the planner missed one. HYBRID
  // carries a search query too (Sprint 8A.4's SEARCH+document overlay),
  // so it needs the same safety net as SEARCH.
  if ((decision.route === 'SEARCH' || decision.route === 'HYBRID') && decision.query) {
    const { resolvedQuery, wasResolved, entity } = resolveQuery({ query: decision.query, sessionId });
    if (wasResolved) {
      if (isDev) console.log(`[SearchRouter] Context Resolver (planner safety net): "${decision.query}" → "${resolvedQuery}"`);
      decision.query = resolvedQuery;
      // Same bug fix as above: only backfill if the LLM path (which
      // already ran its own memory lookup inside finalizeDecision) didn't
      // already report a resolution — never overwrite a real signal with
      // this fallback one.
      if (!decision.entity_used) {
        decision.entity_used = entity;
        decision.memory_relevance = Math.max(decision.memory_relevance, 0.75);
      }
    }
  }

  if (isDev) {
    if (decision.route === 'SEARCH' || decision.route === 'HYBRID') {
      console.log(`[SearchRouter] ${decision.route} — category="${decision.category}", confidence=${decision.confidence.toFixed(2)}, reason=${decision.reason}, doc_rel=${decision.document_relevance}`);
    } else if (decision.route === 'CLARIFY') {
      console.log(`[SearchRouter] Search deferred — clarification needed (reason=${decision.reason})`);
    } else if (decision.route === 'DOCUMENT') {
      console.log(`[SearchRouter] DOCUMENT — doc_rel=${decision.document_relevance}, reason=${decision.reason}`);
    } else {
      console.log(`[SearchRouter] Search skipped (reason=${decision.reason})`);
    }
  }

  return decision;
}

export default { routeSearchDecision };
