# Nocturnal AI — Architecture

> Project Atlas · Last updated: Sprint 3

---

## Guiding Philosophy

Nocturnal is not a chatbot. It is a modular AI platform built around
independent services that work together to produce the best possible
response while remaining affordable enough to run on free-tier infrastructure.

**The orchestration layer is the product. Models are interchangeable.**

Every capability lives in a dedicated service with a clearly defined
responsibility. The core chat pipeline (`server.js`) stays thin — it
orchestrates, it does not implement.

---

## Model Configuration

**Single source of truth: `config/models.js`**

All AI model identifiers are defined in one place. Nothing else in the
codebase hardcodes a model string.

### Chat Models (user-selectable)

| Mode | Model | Purpose |
|---|---|---|
| `flash` | `nvidia/nemotron-3-nano-30b-a3b` | Fast, conversational, low latency |
| `insight` | `nvidia/nemotron-3-super-120b-a12b` | Balanced — code, debugging, explanations |
| `abyss` | `nvidia/nemotron-3-ultra-550b-a55b` | Deep reasoning, research, complex analysis |

All three are served through NVIDIA NIM (`integrate.api.nvidia.com`) via
the generic AI provider abstraction (`lib/providers/`).

### Vision Model (internal — not user-selectable)

| Model | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` |
|---|---|
| **Purpose** | OCR, image understanding, document extraction |
| **Status** | Reserved for the future Vision Service sprint |
| **Pipeline** | Image → Vision Service → structured text → Router → Flash/Insight/Abyss |

`VISION_MODEL` must never appear in user-facing mode lists or BYOK pickers.
It is an internal service input, not a conversation model.

### Planner Model

| Model | `meta/llama-3.3-70b-instruct` (NVIDIA) |
|---|---|
| **Purpose** | Routing/classification only — CHAT / SEARCH / CLARIFY decisions |
| **Independent of** | `MODELS.flash/insight/abyss` — a dedicated `PLANNER_MODEL` constant, not derived from any chat mode |
| **Settings** | `temperature: 0`, low `maxTokens` (small JSON object only) |

Previously the planner reused `MODELS.flash` (Nemotron). In practice that
model was unreliable as a classifier — it frequently ignored the JSON-only
instruction, emitted reasoning text ("We need to classify the latest
message...") ahead of the JSON, and truncated output. Planner retry/JSON
recovery (`lib/planner.js`, Sprint 3.1) compensates for occasional bad
output, but not for a model that doesn't reliably follow an output
contract at all.

`PLANNER_MODEL` now points at a dedicated NVIDIA model chosen for
instruction-following reliability at small output sizes, decoupled from
chat mode selection: changing Flash/Insight/Abyss never affects routing,
and changing the planner model never affects conversation quality. Both
run through the same NVIDIA provider client (`lib/providers/nvidia.js`) —
only the model ID passed per-call differs.

---

## Request Pipeline

Every `/chat` request flows through this sequence:

```
User message
     │
     ▼
1. Auth middleware         (requireAuth — Supabase token verification)
     │
     ▼
2. Input validation        (validateChatRequest — length, image type/size)
     │
     ▼
3. Local Tools             (matchLocalTool — time/date; no AI, no search, zero cost)
     │ (only if no image attached)
     ▼
4. Mode resolution         (see Mode Routing below)
     │
     ▼
5. Search Routing          (ALL text modes — lib/searchRouter.js, see below)
     │
     ▼
6. Search                  (SEARCH route only — SearchService via services/search/)
     │
     ▼
7. Personality + system prompt assembly
     │
     ▼
8. Completion              (NVIDIA NIM via lib/providers/ — BYOK or default)
     │
     ▼
9. saveConversationToDatabase (async, fire-and-forget)
     │
     ▼
Response
```

---

## Mode Routing

Mode routing has two separate, independent layers that never know about
each other. As of Sprint 3, **both layers run for every text request** —
tier selection no longer gates whether search routing happens.

### Layer 1 — Tier selection (which model answers)

Determines which model tier (Flash/Insight/Abyss) is used for the completion.

| Input mode | Behaviour |
|---|---|
| `flash` | Uses Flash directly. |
| `insight` | Uses Insight directly. |
| `abyss` | Uses Abyss directly. |
| `auto` | Runs `autoSelectMode()` (keyword engine in `server.js`) to pick Flash/Insight/Abyss. |
| image attached | Always forced to Abyss (current behaviour). Future: routed to Vision Service. |

### Layer 2 — Search routing (does the model need live information)

Runs for **every text mode** — Flash, Insight, Abyss, and Auto alike — via
`lib/searchRouter.js` (see below). Sprint 2/8.x tied this to Auto mode only;
Sprint 3 removed that coupling. Search is a capability that sits above mode
selection, not a feature of the Auto tier:

```
Flash   ↓ Search (if required) ↓ Flash model
Insight ↓ Search (if required) ↓ Insight model
Abyss   ↓ Search (if required) ↓ Abyss model
Auto    ↓ Search (if required) ↓ auto-selected model
```

| Router route | Behaviour |
|---|---|
| `CHAT` | Model answers from training knowledge. No search. |
| `SEARCH` | Live web context injected before the completion call. |
| `CLARIFY` | Model asks a narrowing question instead of guessing. |

The user's selected mode is never read or altered by search routing, and
search routing never selects a model tier. The two layers only ever meet
inside the final completion call, where whichever tier was chosen answers
using whatever context (if any) search routing injected.

Images skip Layer 2 entirely — that path is deterministic (image attached
→ Vision Service in a future sprint; for now → Abyss directly) and doesn't
need a routing call.

**Follow-up awareness:** the planner receives the last few turns of
conversation (`history.slice(-4)`) alongside the new message. Its Step 1
("context-first") routing rule checks whether the message is answerable
from that recent conversation before ever considering SEARCH — so "what
does he do?" after a message about a person, or "what GPUs were
announced?" right after an NVIDIA-news search, both route to CHAT and
reuse the existing context instead of re-searching. This is tagged
`reason: 'follow_up'` (see Decision Reasons below) for debugging.

---

## Search Router

**Location:** `lib/searchRouter.js`

**Called by:** `server.js` `/chat` route — every text request (all modes).

**Responsibility:** Single source of truth for *whether* Search executes.
This is the module Sprint 3 introduced to centralize search decision logic
that previously lived inline in `server.js`, gated behind `mode === 'auto'`.
It wraps the Capability Planner (below) and adds:

- The image skip-check (deterministic, no LLM call).
- Development logging of the routing outcome (`Search requested` /
  `Search skipped` / clarification-deferred), gated behind
  `NODE_ENV !== 'production'` so it never runs in production.

`server.js` calls `routeSearchDecision()` once per request and acts on the
returned `{ route, query, category, confidence, reason, clarify }` — it never talks
to the planner directly, and `SearchService` never decides *when* to run,
only *how* (see Search Service below). This keeps the "when" and the "how"
in exactly one place each.

---

## Capability Planner

**Location:** `lib/planner.js`

**Called by:** `lib/searchRouter.js` — never called directly by `server.js`.

**Responsibility:** Classify a single message as `CHAT`, `SEARCH`, or
`CLARIFY`. Does not select the model tier (that is Layer 1 above) and does
not decide whether it should run at all (that's `searchRouter.js`'s job).

**Output shape:**
```json
{
  "route": "CHAT" | "SEARCH" | "CLARIFY",
  "query": "standalone search query (SEARCH only)",
  "category": "search category (SEARCH only)",
  "confidence": 0.0–1.0,
  "reason": "stable_knowledge | fresh_information | follow_up | ambiguous_request | planner_retry",
  "clarify": "narrowing question (CLARIFY only)"
}
```

**Reliability rules:**
- Prompt demands exactly one JSON object — no preamble, no reasoning text,
  no `<think>` blocks, no markdown fences.
- `safeParsePlannerOutput()` strips any accidental markdown fences as a
  defensive fallback.
- Low-confidence SEARCH calls (`< 0.55`) are downgraded to CHAT before
  reaching the search layer.
- CLARIFY with an empty question is downgraded to CHAT.
- **Uses:** `PLANNER_MODEL` (dedicated `meta/llama-3.3-70b-instruct`, independent of chat mode) on the shared default AI client.
  Never uses a user's BYOK key — planner cost must be predictable.
  `temperature: 0` for deterministic classification.

### Planner Retry Strategy (Sprint 3.1)

The planner call has a bounded, two-attempt reliability path instead of
failing to CHAT on the first bad response:

1. **Attempt 1** — call the model, try to parse the response as JSON.
2. **Safe recovery** — if the raw parse fails (e.g. the model wrapped valid
   JSON in stray prose), extract the first `{...}` block from the text and
   retry the parse before giving up on this attempt.
3. **Attempt 2 (retry)** — if the response is still unparseable, the planner
   is called exactly once more with the same prompt. This is a fixed retry
   budget — never more than one retry — to keep planner latency bounded.
4. **Final fallback** — if attempt 2 also fails to parse, the decision
   falls back to `{ route: 'CHAT', reason: 'ambiguous_request' }`. Network
   errors (timeout, provider failure) skip straight to this fallback rather
   than retrying, since a retry won't fix a downed provider.

A decision that only exists because attempt 1 failed to parse is tagged
`reason: 'planner_retry'` so it's visible in logs, without changing the
route or confidence value itself.

### Decision Reasons (Sprint 3.1)

Every planner decision carries an internal `reason` alongside `route`.
Reasons are for logging/debugging only — they never reach the user and
never gate behavior on their own.

| Reason | Meaning |
|---|---|
| `stable_knowledge` | CHAT — timeless/general knowledge, or about Nocturnal itself |
| `follow_up` | CHAT — resolvable from the recent conversation shown to the planner |
| `fresh_information` | SEARCH — current/live/real-world info genuinely required |
| `ambiguous_request` | CLARIFY — too vague to form a useful search query |
| `planner_retry` | The decision only succeeded on the second (retry) attempt |
| `search_failed` | SearchService threw after a SEARCH decision (logged in `server.js`, not part of the planner's own output) |

**Logging:** with `NODE_ENV !== 'production'`, the planner logs the raw
model response (truncated), whether safe-recovery was needed, each retry
attempt, and the final routing decision with its reason — enough to
reconstruct why any given message was or wasn't searched without
guessing.

---

## AI Provider Layer

**Location:** `lib/providers/`

```
lib/providers/
  index.js      Generic interface + provider registry
  nvidia.js     NVIDIA NIM implementation
```

**Interface:** Every provider exposes one method:
```js
client.chatComplete({ model, messages, temperature, maxTokens, signal })
// → { choices: [{ message: { content } }] }
```

`server.js` and `lib/planner.js` only ever call `chatComplete()`. They
never know which provider generated the response.

**Adding a provider (e.g. Gemini fallback):**
1. Create `lib/providers/gemini.js` implementing the same interface.
2. Register it in `lib/providers/index.js`.
3. Set `AI_PROVIDER=gemini` in `.env` (or add fallback logic to `index.js`).
4. Nothing else in the codebase changes.

---

## Search Service

**Location:** `services/search/`

```
services/search/
  index.js          SearchService — public interface + provider registry
  tavily.js         Tavily implementation
  cache.js          Per-category TTL cache
  formatContext.js  Result → prompt context formatter

config/search.js    Default provider, max results, timeout, categories
```

Mirrors the AI provider layer's shape (`lib/providers/`): a stable public
interface, a provider registry, and per-provider implementation files.
`server.js` never talks to Tavily, or to the cache module, directly — it
only ever calls `SearchService.search()`.

### Pipeline

```
server.js
     │
     ▼
SearchService.search(query, options)
     │
     ├─ cache HIT  → return cached normalized results immediately
     │
     └─ cache MISS
            │
            ▼
        Search Provider   (currently Tavily; interface-compatible with
                            Brave Search / SearXNG / DuckDuckGo later)
            │
            ▼
        Normalized Results
            │
            ▼
        cache write (per-category TTL)
            │
            ▼
     Normalized Results → AI (via formatSearchContext)
```

Only invoked for Auto mode requests routed to `SEARCH` by the planner.
Manual modes never trigger a search, regardless of message content.
Caching and provider selection are entirely internal to
`SearchService.search()` — `server.js` just awaits one call and gets a
normalized result back, or catches an error and proceeds without search
context.

### Public Interface

```js
import * as SearchService from './services/search/index.js';

const { provider, query, results } = await SearchService.search(query, {
  category: 'sports',   // optional — drives cache TTL + provider recency behavior
  maxResults: 5,         // optional — defaults from config/search.js
});
```

### Normalized Result Shape

Every provider, regardless of its own raw response format, must return
(and `SearchService.search()` always resolves to) this shape:

```json
{
  "provider": "tavily",
  "query": "...",
  "results": [
    { "title": "...", "url": "...", "snippet": "...", "publishedDate": "..." }
  ]
}
```

`server.js` and `formatSearchContext()` depend only on this shape, never
on a specific provider's raw response fields.

### Current Provider

**Tavily** (`services/search/tavily.js`) — REST API, `topic: 'news'` +
short `time_range` for recency-sensitive categories (current affairs,
sports, finance), general search otherwise.

### Planned Future Providers

| Provider | Status |
|---|---|
| Tavily | ✅ Active |
| Brave Search | 🔜 Planned |
| SearXNG | 🔜 Planned |
| DuckDuckGo | 🔜 Planned |

**Adding a search provider:**
1. Create `services/search/<name>.js` implementing the provider interface
   (`{ name, search(query, opts) }`, returning `[{ title, url, snippet }]`).
2. Register it in `services/search/index.js`'s `registry`.
3. Set `SEARCH_PROVIDER=<name>` in `.env`.
4. Nothing else in the codebase changes — `server.js`, the planner, and
   the cache module are all provider-agnostic.

---

## Vision Service (Future Sprint)

**Not yet implemented.** Architecture is prepared.

**Intended pipeline:**
```
Image attached
     │
     ▼
Vision Service  (VISION_MODEL — OCR, image understanding, extraction)
     │
     ▼
Structured text output
     │
     ▼
Router          (selects Flash/Insight/Abyss based on the extracted content)
     │
     ▼
Completion
```

Currently, image-attached requests are forced directly to Abyss as a
temporary measure. The `VISION_MODEL` constant is defined and reserved;
no other code references it yet.

---

## Cost Philosophy

Every architectural decision considers operational cost.

| Technique | Saving |
|---|---|
| Local Tools layer | Eliminates AI calls entirely for time/date requests |
| Planner gated to Auto only | Eliminates one LLM round-trip per manual-mode request |
| Search confidence threshold | Avoids wasted search calls on low-confidence routes |
| Search cache (per-category TTL) | Avoids redundant provider calls for identical queries |
| Plain `fetch` in provider (no SDK) | No extra dependency for a standard REST API |
| Browser-native voice (Web Speech API) | Zero backend cost for voice input/output |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NVIDIA_API_KEY` | Yes | NVIDIA NIM API key (server default) |
| `AI_PROVIDER` | No | Provider name (defaults to `nvidia`) |
| `TAVILY_API_KEY` | Yes | Search provider key |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server-side only) |
| `SUPABASE_ANON_KEY` | Yes | Supabase anon key (browser-safe) |
| `SETTINGS_ENCRYPTION_KEY` | Yes | 64-char hex key for AES-256-GCM BYOK encryption |
| `FRONTEND_URL` | Production | Allowed CORS origin |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Set to `production` when deploying |

---

## Sprint Status

| Sprint | Status | Summary |
|---|---|---|
| Sprint 1 | ✅ Complete | Provider abstraction; NVIDIA primary; Groq removed |
| Sprint 1.1 | ✅ Complete | `saveConversationToDatabase` regression fix |
| Sprint 1.2 | ✅ Complete | Model config extracted; planner gated to Auto; prompt hardened |
| Sprint 2 | ✅ Complete | Search Service extracted (`services/search/`); `config/search.js` added; `server.js` decoupled from Tavily |
| Sprint 3 | ✅ Complete | Search routing decoupled from Auto mode (`lib/searchRouter.js`); Search is now an independent capability available to Flash/Insight/Abyss/Auto alike |
| Sprint 4 | 🔜 Next | Vision Service |
