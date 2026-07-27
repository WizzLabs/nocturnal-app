// ─── VISION SERVICE ──────────────────────────────────────
// Sprint 4: the perception engine. Owns the single responsibility of
// turning an attached image into structured Vision Analysis:
//
//   image → Vision Model (multimodal) → raw response → normalized analysis
//
// This module NEVER produces the user-facing reply. Its output is always
// handed to promptBuilder.buildGroundedPrompt() and then to whichever
// chat model (Flash/Insight/Abyss) is currently selected — see server.js.
//
// Mirrors the shape/conventions of services/search/index.js: a plain
// async function, normalized return shape, never throws — callers get
// { ok: true, analysis } or { ok: false, error } and are responsible for
// failing gracefully (server.js never exposes raw provider errors).

import { buildAnalysisRequestMessages } from './promptBuilder.js';

const VISION_TIMEOUT_MS = 30 * 1000; // matches server.js REQUEST_TIMEOUT_MS

// Extracts the first {...} block from raw model output and parses it.
// Vision models occasionally wrap JSON in prose or code fences despite
// instructions — this is more resilient than requiring an exact match.
function extractJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Fills in a stable, predictable shape regardless of what the model
// actually returned — every field is always present with a safe default,
// so promptBuilder and server.js never need to null-check.
function normalizeAnalysis(parsed) {
  return {
    description: typeof parsed?.description === 'string' ? parsed.description.trim() : '',
    ocr: typeof parsed?.ocr === 'string' ? parsed.ocr.trim() : '',
    objects: Array.isArray(parsed?.objects)
      ? parsed.objects.filter(o => typeof o === 'string' && o.trim()).map(o => o.trim())
      : [],
    scene: typeof parsed?.scene === 'string' ? parsed.scene.trim() : '',
    confidence: typeof parsed?.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : null,
  };
}

// Sends the image to the Vision Model and returns normalized analysis.
//   client   — AI provider client (from lib/providers), already resolved
//   model    — VISION_MODEL, resolved by lib/visionRouter.js
//   image    — base64 data URL, already validated by server.js
//   question — the user's message, given to the vision model as focus context
export async function analyzeImage({ client, model, image, question }) {
  console.log('[Vision] Image received');
  console.log(`[Vision] Routing → ${model}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

  try {
    const messages = buildAnalysisRequestMessages({ image, question });
    const completion = await client.chatComplete({
      model,
      messages,
      temperature: 0.2,
      maxTokens: 1024,
      signal: controller.signal,
    });

    const raw = completion?.choices?.[0]?.message?.content || '';
    if (!raw.trim()) {
      console.warn('[Vision] Empty response from Vision Model');
      return { ok: false, error: 'empty_response' };
    }

    const parsed = extractJson(raw);
    if (!parsed) {
      // Not valid JSON — fail soft rather than losing the analysis
      // entirely. Treat the raw text as the description so the chat
      // model still has something grounded to work with.
      console.warn('[Vision] Could not parse structured JSON, using raw text as description');
      const analysis = normalizeAnalysis({ description: raw.trim() });
      console.log('[Vision] Analysis complete (unstructured fallback)');
      return { ok: true, analysis };
    }

    const analysis = normalizeAnalysis(parsed);
    console.log('[Vision] Analysis complete');
    if (analysis.ocr) console.log('[Vision] OCR extracted');
    return { ok: true, analysis };
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[Vision] Request timed out');
      return { ok: false, error: 'timeout' };
    }
    console.warn('[Vision] Analysis failed:', err.message);
    return { ok: false, error: 'provider_error' };
  } finally {
    clearTimeout(timeoutId);
  }
}

export default { analyzeImage };
