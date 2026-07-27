// ─── VISION PROMPT BUILDER ───────────────────────────────
// Sprint 4: two distinct prompts, both internal-only (the user never sees
// either of them):
//
//   1. buildAnalysisRequestMessages — sent TO the Vision Model. Instructs
//      it to return structured JSON perception data, nothing else.
//
//   2. buildGroundedPrompt — sent TO the currently-selected chat model
//      (Flash/Insight/Abyss). Combines the Vision Analysis with the user's
//      actual question so the chat model can answer naturally, grounded
//      only in what the Vision Service actually saw.
//
// Neither function talks to a network — pure string assembly, easy to
// unit test and easy to tune independently of the Vision Service itself.

const ANALYSIS_INSTRUCTION = `You are a vision perception engine. Analyze the attached image and return ONLY a single JSON object — no other text, no markdown code fences — with exactly this shape:

{
  "description": "a clear, factual description of what the image shows",
  "ocr": "any visible text in the image, transcribed as accurately as possible, or an empty string if there is none",
  "objects": ["notable", "objects", "or", "UI", "elements", "present"],
  "scene": "brief description of the setting/context (e.g. photo, screenshot, chart, document, diagram)",
  "confidence": 0.0
}

Be strictly factual. Only describe what is actually visible — never guess at details you cannot confirm. If text is partially unreadable, transcribe what you can and reflect the uncertainty in the "ocr" field itself rather than omitting it. "confidence" is your own confidence in this analysis, from 0.0 to 1.0.`;

// Messages sent to the Vision Model. `question` gives the vision model the
// user's actual question as context (helps it focus, e.g. on OCR text vs.
// general scene description) without it ever generating the final reply.
export function buildAnalysisRequestMessages({ image, question }) {
  return [
    { role: 'system', content: ANALYSIS_INSTRUCTION },
    {
      role: 'user',
      content: [
        { type: 'text', text: question && question.trim() ? question : 'Analyze this image.' },
        { type: 'image_url', image_url: { url: image } },
      ],
    },
  ];
}

// Builds the internal instruction handed to the currently-selected chat
// model. The chat model never receives the raw image — only this
// structured summary — so it cannot hallucinate details outside of it.
export function buildGroundedPrompt({ question, analysis }) {
  const ocrSection = analysis.ocr && analysis.ocr.trim()
    ? `OCR:\n${analysis.ocr.trim()}`
    : `OCR:\n(no readable text detected)`;

  const objectsSection = analysis.objects && analysis.objects.length
    ? `Objects:\n${analysis.objects.join(', ')}`
    : `Objects:\n(none notable)`;

  const confidenceNote = typeof analysis.confidence === 'number' && analysis.confidence < 0.6
    ? `\nNote: this analysis has relatively low confidence (${analysis.confidence}). If asked about details not clearly present above, say plainly that you're not certain rather than guessing.`
    : '';

  return `The Vision Service analyzed an attached image. Use ONLY the analysis below to answer — never invent details that aren't present in it.

Vision Analysis:

Description:
${analysis.description || '(no description available)'}

${ocrSection}

${objectsSection}

Scene:
${analysis.scene || '(not specified)'}
${confidenceNote}

The user asked:

"${question}"

Answer naturally using the Vision Analysis above, in your normal voice and format for this mode. Do not mention "Vision Analysis", "Vision Service", or that this information was structured/passed to you — just answer as if you looked at the image yourself. If the analysis is uncertain or incomplete on something the user asked about, say so clearly instead of guessing.`;
}

export default { buildAnalysisRequestMessages, buildGroundedPrompt };
