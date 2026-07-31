// ─── CONTEXT RESOLVER ───────────────────────────────────
// Sprint 3.3: deterministic (no LLM call) resolution of pronouns in a
// follow-up query against the active conversation's Entity Store
// (lib/entityStore.js).
//
//   "Who created Python?"                → entity recorded: Python
//   "What's the latest version of it?"   → ContextResolver → "latest version of Python"
//
// Sprint 8A.2 — Pronoun Resolution V2:
//   - Upgraded from the single "current subject" store to the typed,
//     multi-entity store from Sprint 8A.1. Pronouns are now resolved by
//     TYPE, not just recency: "he/his" prefers the most recent Person,
//     "it/its" prefers the most recent non-Person entity, "they/their"
//     prefers Person/Organization/Company. A message with two pronouns
//     of different kinds ("he said it was broken") can now resolve each
//     one against a DIFFERENT stored entity, which was impossible with
//     the old single-subject store.
//   - Newly extracted entities are typed via lib/entityTypeClassifier.js
//     (dictionary + pattern heuristics, no LLM) instead of always landing
//     as "Unknown", so there's actually something for type-aware
//     resolution to select between.
//   - Generalized beyond SEARCH: resolveQuery() works on any string, and
//     resolveMessage() is exported as the explicit general-chat-facing
//     entry point (same logic, chat-oriented naming) for future callers
//     that aren't building a search query. NOTE: this phase adds and
//     tests the capability at the module level only — wiring it into the
//     live chat prompt is deliberately deferred to a later phase so this
//     sprint doesn't touch server.js's planner/prompt-assembly flow.
//
// This module still owns exactly two things: extracting a likely
// "subject entity" from a message, and substituting known pronouns in a
// later message with the right stored entity. It never calls Search,
// never calls the planner, never touches the cache — same "pure code"
// constraint as FastPathRouter.

import { recordEntity, getEntities, getEntityByType, getPrimaryEntity } from './entityStore.js';
import { classifyEntityType } from './entityTypeClassifier.js';

// Pronouns that can stand in for a previously-mentioned entity. Matched as
// whole words only (case-insensitive) so we never mangle words like
// "history" or "this" inside another token.
const PRONOUNS = ['it', 'its', 'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'this', 'that', 'those', 'these'];
const PRONOUN_PATTERN = new RegExp(`\\b(${PRONOUNS.join('|')})\\b`, 'i');

// Sprint 8A.2 — pronoun -> preferred entity type(s), most-preferred first.
// A null `types` entry means "no type preference" (demonstratives like
// "this"/"that" don't imply a category) — those fall back to the most
// recent entity of any type, same as pre-8A.2 behavior.
const PRONOUN_TYPE_RULES = {
  he: { types: ['Person'] },
  him: { types: ['Person'] },
  his: { types: ['Person'] },
  she: { types: ['Person'] },
  her: { types: ['Person'] },
  hers: { types: ['Person'] },
  they: { types: ['Person', 'Organization', 'Company'] },
  them: { types: ['Person', 'Organization', 'Company'] },
  their: { types: ['Person', 'Organization', 'Company'] },
  // "it/its" almost never refers to a Person — prefer the most recent
  // NON-Person entity (Project/Document/Hardware/etc.), falling back to
  // any entity only if nothing else is stored.
  it: { excludeTypes: ['Person'] },
  its: { excludeTypes: ['Person'] },
  this: { types: null },
  that: { types: null },
  these: { types: null },
  those: { types: null },
};

// Resolves a single pronoun to the best-matching stored entity for this
// session, or null if nothing suitable is stored. Pure lookup — never
// mutates the store.
function resolveEntityForPronoun(sessionId, pronoun) {
  const rule = PRONOUN_TYPE_RULES[pronoun.toLowerCase()];
  if (!rule) return getPrimaryEntity(sessionId);

  if (Array.isArray(rule.types)) {
    for (const type of rule.types) {
      const match = getEntityByType(sessionId, type);
      if (match) return match;
    }
    // No entity of any preferred type — fall through to "any entity"
    // rather than leaving a resolvable pronoun unresolved.
    return getPrimaryEntity(sessionId);
  }

  if (Array.isArray(rule.excludeTypes)) {
    const candidates = getEntities(sessionId).filter(e => !rule.excludeTypes.includes(e.type));
    if (candidates.length) return candidates[0]; // already MRU-ordered
    return getPrimaryEntity(sessionId);
  }

  // rule.types === null (demonstrative, no type preference)
  return getPrimaryEntity(sessionId);
}

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

  // Also expose a lowercase single-word candidate for the dictionary-based
  // classifier (Objective 3 types like "python", "esp32" are rarely
  // capitalized mid-sentence, e.g. "explain setup() on esp32").
  if (!bestRun.length) return null;
  return bestRun.join(' ');
}

// Lowercase dictionary terms (hardware, sensors, languages, etc.) are
// frequently NOT capitalized in casual messages ("explain the mpu6050
// wiring"), so extractEntity's capitalization-based heuristic alone would
// miss them. This second, narrower pass only fires when the primary
// extractor found nothing, and only matches a single lowercase token
// immediately following a small set of introduction cues — deliberately
// conservative so it doesn't start extracting random nouns.
const LOWERCASE_INTRO_PATTERN = /\b(?:on|about|using|with|for)\s+([a-z][\w.+#-]{2,})\b/i;

function extractLowercaseCandidate(rawMessage) {
  const match = rawMessage.match(LOWERCASE_INTRO_PATTERN);
  return match ? match[1] : null;
}

// Records the entity extracted from a message into the session's Entity
// Store, if one is confidently found. Safe to call on every request —
// no-ops silently when extraction finds nothing, never clears a known
// entity just because a later message didn't mention one.
//
// Sprint 8A.2: now types the extracted entity via entityTypeClassifier
// (dictionary + "who is X" heuristics) and writes through the upgraded
// entityStore.recordEntity API instead of the legacy single-subject
// setEntity — return value/behavior for callers is unchanged (still just
// the extracted name, still a silent no-op on nothing found).
export function recordEntityFromMessage({ sessionId, message }) {
  const entity = extractEntity(message) || extractLowercaseCandidate(message || '');
  if (!entity) return null;

  const { type, confidence } = classifyEntityType(entity, message);
  recordEntity(sessionId, { name: entity, type, confidence, source: 'context_resolver', lastQuery: message });
  return entity;
}

// Continuation cues — words that signal "more of the same topic" without
// using an explicit pronoun (e.g. "any latest announcements?" after
// "Tell me about NVIDIA."). Deliberately a short, conservative list so
// this fallback only fires on genuinely topic-continuing phrasing, not on
// every short SEARCH query — an unrelated fresh query like "what's the
// weather today" must never get an unrelated stored entity injected into it.
const CONTINUATION_CUES = /\b(any|further|more|additional|other)\b/i;

// Resolves a follow-up string against the session's stored entities.
// Returns { resolvedQuery, wasResolved, entity, entityType }.
//
// Sprint 8A.2: this now works pronoun-by-pronoun rather than substituting
// every matched pronoun with the same single entity — each pronoun is
// resolved against the type of entity it actually implies (see
// PRONOUN_TYPE_RULES above), so "he... it..." in one message can resolve
// to two different stored entities. `entity`/`entityType` on the return
// value reflect the FIRST resolution made, for simple callers/logging
// that only care about one; callers needing every substitution can infer
// them from `resolvedQuery` itself.
//
// Two resolution paths, both requiring at least one stored entity:
//   1. Explicit pronoun ("it", "he", "this", ...) — substituted per-type.
//   2. Entity-less continuation ("any latest announcements?") — the query
//      has no subject of its own AND uses a continuation cue word, so the
//      most recent entity (any type) is prepended.
// Anything else is returned unchanged (fails open — never guesses).
export function resolveQuery({ query, sessionId }) {
  if (typeof query !== 'string' || !query.trim()) {
    return { resolvedQuery: query, wasResolved: false, entity: null, entityType: null };
  }

  const hasPronoun = PRONOUN_PATTERN.test(query);
  const hasContinuationCue = CONTINUATION_CUES.test(query);

  if (!hasPronoun && !hasContinuationCue) {
    return { resolvedQuery: query, wasResolved: false, entity: null, entityType: null };
  }

  if (hasPronoun) {
    let resolvedQuery = query;
    let wasResolved = false;
    let firstEntity = null;
    let firstType = null;

    // Replace pronoun-by-pronoun (not a single blanket regex) so each
    // pronoun type can pull a different stored entity.
    for (const pronoun of PRONOUNS) {
      const wordPattern = new RegExp(`\\b${pronoun}\\b`, 'i');
      if (!wordPattern.test(resolvedQuery)) continue;

      const match = resolveEntityForPronoun(sessionId, pronoun);
      if (!match) continue; // nothing suitable stored — leave this pronoun as-is (fail open)

      resolvedQuery = resolvedQuery.replace(new RegExp(`\\b${pronoun}\\b`, 'gi'), match.name);
      wasResolved = true;
      if (!firstEntity) {
        firstEntity = match.name;
        firstType = match.type;
      }
    }

    if (wasResolved) {
      return { resolvedQuery, wasResolved: true, entity: firstEntity, entityType: firstType };
    }
    // Pronouns were present but nothing was stored to resolve them against —
    // fall through to the continuation-cue path in case that still applies.
  }

  // Continuation-cue path: only fires when the query has no subject of its
  // own — if it already names something (extractEntity finds a proper
  // noun), that's the real subject and we must not overwrite it.
  if (hasContinuationCue && !extractEntity(query)) {
    const stored = getPrimaryEntity(sessionId);
    if (stored) {
      const resolvedQuery = `${stored.name} ${query}`;
      return { resolvedQuery, wasResolved: true, entity: stored.name, entityType: stored.type };
    }
  }

  return { resolvedQuery: query, wasResolved: false, entity: null, entityType: null };
}

// Sprint 8A.2 — explicit general-chat-facing entry point. Identical
// resolution logic to resolveQuery (SEARCH is not special-cased inside
// this module — it never was), exposed under chat-oriented naming so
// future callers outside the search path (chat prompt assembly, hybrid
// answering, etc.) have a name that doesn't imply "only for search
// queries". Kept as a thin wrapper rather than a copy so the two can
// never drift apart.
export function resolveMessage({ message, sessionId }) {
  const { resolvedQuery, wasResolved, entity, entityType } = resolveQuery({ query: message, sessionId });
  return { resolvedMessage: resolvedQuery, wasResolved, entity, entityType };
}

export default { extractEntity, recordEntityFromMessage, resolveQuery, resolveMessage };
