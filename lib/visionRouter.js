// ─── VISION ROUTER ──────────────────────────────────────
// Sprint 3.3: single responsibility module that decides what model an
// image-attached request goes to. Before this module existed, an attached
// image forced selectedMode = "abyss" in server.js and then reused
// MODELS[selectedMode] (the abyss CHAT model) to answer — VISION_MODEL
// (config/models.js) was defined but never actually used. That meant
// images were silently being sent to a model never declared as
// vision-capable, and the currently-selected chat model's own tier
// (flash/insight/abyss) was overridden for no reason other than a stale
// assumption that abyss was "the" vision model.
//
//   User → image attached → VisionRouter.routeVision() → Vision Model → Response
//
// This module owns exactly one decision: given an image is attached,
// which model answers it, or whether the request should fail gracefully
// instead. It never decides text routing (FastPathRouter/SearchRouter own
// that) and never touches Flash/Insight/Abyss mode selection — those stay
// completely unchanged for text-only conversations, same as before this
// sprint.
//
// Sprint 4 (Vision Service) will likely expand this into a real service
// (OCR, structured extraction, etc.) — this module is intentionally the
// minimal, stable seam that sprint will build on, not a preview of it.

import { VISION_MODEL } from '../config/models.js';

// Returns a routing verdict for an image-attached request:
//   { ok: true, model }                         — route to this vision model
//   { ok: false, error }                        — no vision model configured;
//                                                  caller must fail gracefully
//                                                  instead of falling back to
//                                                  a text-only chat model.
//
// Deliberately has no knowledge of which chat mode (flash/insight/abyss)
// the user had selected — that selection is for text conversations only.
export function routeVision() {
  if (!VISION_MODEL || typeof VISION_MODEL !== 'string' || !VISION_MODEL.trim()) {
    return {
      ok: false,
      error: 'No vision-capable model is configured for image analysis right now.',
    };
  }
  return { ok: true, model: VISION_MODEL };
}

export default { routeVision };
