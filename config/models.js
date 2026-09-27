// ─── MODEL CONFIGURATION ────────────────────────────────
// Single source of truth for all AI model identifiers used by Nocturnal.
// All values are NVIDIA NIM model IDs (integrate.api.nvidia.com).
//
// To update a model, change the string here — nothing else needs to change.
// To swap providers entirely, update lib/providers/ and the IDs here.
//
// ── Chat models (user-selectable modes) ──────────────────
// Three tiers: fast/cheap → balanced → deep reasoning.
// All three are available as explicit modes AND as Auto routing targets.
export const MODELS = {
  flash:   "nvidia/nemotron-3-super-120b-a12b",
  insight: "nvidia/nemotron-3-super-120b-a12b",
  abyss:   "nvidia/nemotron-3-ultra-550b-a55b",
};

// ── Vision model (internal service — NOT user-selectable) ─
// Used by the future Vision Service sprint for OCR, image understanding,
// and document extraction. The output of the vision service (structured
// text) is then routed to Flash/Insight/Abyss for the final response.
// This model must never appear in user-facing mode lists or BYOK pickers.
export const VISION_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";

// ── Planner model ─────────────────────────────────────────
// Dedicated routing/classification model — deliberately NOT tied to any
// chat mode (Flash/Insight/Abyss). Those three exist for user-facing
// conversation quality and can change independently (model swaps, tuning,
// etc.) without ever affecting routing reliability, and vice versa.
//
// Previously reused MODELS.flash (Nemotron), which was unreliable as a
// classifier: it frequently ignored the JSON-only instruction, emitted
// reasoning text ("We need to classify..."), and truncated output. Planner
// retry/recovery (lib/planner.js) can compensate for occasional bad output,
// but not for a model that doesn't reliably follow an output contract at
// all — hence a dedicated model rather than a prompt/retry tweak.
//
// Runs on the same NVIDIA provider (lib/providers/nvidia.js) as the chat
// models — only the model ID differs. Called with temperature 0 and a low
// max-token cap (see lib/planner.js) since it only ever returns a small
// JSON object.
export const PLANNER_MODEL = "meta/llama-3.1-8b-instruct";
