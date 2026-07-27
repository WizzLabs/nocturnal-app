// ─── CONTEXT RESOLVER ───────────────────────────────────
// Sprint 3.3: deterministic (no LLM call) resolution of pronouns in a
// follow-up query against the active conversation's Entity Store
// (lib/entityStore.js). Fixes the bug where FastPath's SEARCH verdict
// (lib/fastPathRouter.js, triggered by "fresh" keywords like "latest")
// returned the raw, unresolved message as the search query — e.g.
// "what's the latest version of it" was sent to Tavily verbatim instead
// of being resolved to "latest version of Python".
//
//   "Who created Python?"                → entity recorded: Python
//   "What's the latest version of it?"   → ContextResolver → "latest version of Python"
//
// This module owns exactly two things: extracting a likely "subject
// entity" from a message, and substituting known pronouns in a later
// message with the stored entity. It never calls Search, never calls the
// planner, never touches the cache — same "pure code" constraint as
// FastPathRouter. SearchRouter is the only caller.

import { getEntity, setEntity } from './entityStore.js';

// Pronouns that can stand in for a previously-mentioned entity. Matched as
// whole words only (case-insensitive) so we never mangle words like
// "history" or "this" inside another token.
const PRONOUNS = ['it', 'its', 'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'this', 'that', 'those', 'these'];
const PRONOUN_PATTERN = new RegExp(`\\b(${PRONOUNS.join('|')})\\b`, 'i');

// Sentence-initial interrogatives/fillers that are capitalized purely by
// English sentence-casing, not because they name an entity. Excluded so
// "Who is Donald Trump?" doesn't extract "Who" as the entity.
const NON_ENTITY_LEADS = new Set([
  'who', 'what', 'when', 'where', 'why', 'how', 'is', 'are', 'was', 'were',
  'do', 'does', 'did', 'tell', 'explain', 'describe', 'define', 'the',
  'a', 'an', 'any', 'i', "i'm", 'can', 'could', 'would', 'will',
]);

// Extracts a best-effort "subject entity" from a raw message using simple,
// deterministic heuristics — no LLM. Good enough for the conversational
// patterns this sprint targets (a proper noun introduced as the topic of
// the message), not a general-purpose NER system.
//
// Strategy, in order:
//   1. "about <Entity>" / "on <Entity>" — explicit topic phrasing.
//   2. Longest run of capitalized words elsewhere in the message that
//      isn't a sentence-initial filler word (handles "Who is Donald
//      Trump?" → "Donald Trump", "Who created Python?" → "Python").
//
// Returns null when nothing confident is found — callers must never
// overwrite a known entity with a null/guessed one.
export function extractEntity(rawMessage) {
  if (typeof rawMessage !== 'string' || !rawMessage.trim()) return null;
  const message = rawMessage.trim().replace(/[?!.,]+$/, '');

  const aboutMatch = message.match(/\b(?:about|on)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*)/);
  if (aboutMatch) return aboutMatch[1].trim();

  const words = message.split(/\s+/);
  let bestRun = [];
  let currentRun = [];

  const flushRun = () => {
    if (currentRun.length > bestRun.length) bestRun = currentRun;
    currentRun = [];
  };

  words.forEach((word, idx) => {
    const clean = word.replace(/^[^\w]+|[^\w]+$/g, '');
    const isCapitalized = /^[A-Z][\w'&-]*$/.test(clean);
    const isLeadFiller = NON_ENTITY_LEADS.has(clean.toLowerCase());

    // Sentence-initial word is only usable if it isn't a filler AND the
    // next word is also capitalized (avoids treating an ordinary
    // capitalized sentence-starter like "Explain recursion" as an entity).
    const isSentenceStart = idx === 0;

    if (isCapitalized && !isLeadFiller && !(isSentenceStart && !/^[A-Z][\w'&-]*$/.test((words[1] || '').replace(/^[^\w]+|[^\w]+$/g, '')))) {
      currentRun.push(clean);
    } else {
      flushRun();
    }
  });
  flushRun();

  return bestRun.length ? bestRun.join(' ') : null;
}

// Records the entity extracted from a message into the session's Entity
// Store, if one is confidently found. Safe to call on every request —
// no-ops silently when extraction finds nothing, never clears a known
// entity just because a later message didn't mention one.
export function recordEntityFromMessage({ sessionId, message }) {
  const entity = extractEntity(message);
  if (entity) setEntity(sessionId, entity, message);
  return entity;
}

// Continuation cues — words that signal "more of the same topic" without
// using an explicit pronoun (e.g. "any latest announcements?" after
// "Tell me about NVIDIA."). Deliberately a short, conservative list so
// this fallback only fires on genuinely topic-continuing phrasing, not on
// every short SEARCH query — an unrelated fresh query like "what's the
// weather today" must never get an unrelated stored entity injected into it.
const CONTINUATION_CUES = /\b(any|further|more|additional|other)\b/i;

// Resolves a follow-up query against the session's stored entity.
// Returns { resolvedQuery, wasResolved, entity }.
//
// Two resolution paths, both requiring a stored entity to exist:
//   1. Explicit pronoun ("it", "he", "this", ...) — substituted directly.
//   2. Entity-less continuation ("any latest announcements?") — the query
//      has no subject of its own AND uses a continuation cue word, so the
//      stored entity is prepended.
// Anything else is returned unchanged (fails open — never guesses).
export function resolveQuery({ query, sessionId }) {
  if (typeof query !== 'string' || !query.trim()) {
    return { resolvedQuery: query, wasResolved: false, entity: null };
  }

  const hasPronoun = PRONOUN_PATTERN.test(query);
  const hasContinuationCue = CONTINUATION_CUES.test(query);

  if (!hasPronoun && !hasContinuationCue) {
    return { resolvedQuery: query, wasResolved: false, entity: null };
  }

  const stored = getEntity(sessionId);
  if (!stored || !stored.entity) {
    return { resolvedQuery: query, wasResolved: false, entity: null };
  }

  if (hasPronoun) {
    const resolvedQuery = query.replace(
      new RegExp(`\\b(${PRONOUNS.join('|')})\\b`, 'gi'),
      stored.entity
    );
    return { resolvedQuery, wasResolved: true, entity: stored.entity };
  }

  // Continuation-cue path: only fires when the query has no subject of its
  // own — if it already names something (extractEntity finds a proper
  // noun), that's the real subject and we must not overwrite it.
  if (!extractEntity(query)) {
    const resolvedQuery = `${stored.entity} ${query}`;
    return { resolvedQuery, wasResolved: true, entity: stored.entity };
  }

  return { resolvedQuery: query, wasResolved: false, entity: null };
}

export default { extractEntity, recordEntityFromMessage, resolveQuery };
