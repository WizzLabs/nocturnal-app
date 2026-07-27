// ─── PDF PARSER ───────────────────────────────────────────
// Objective 6: extract text from a PDF. OCR is intentionally NOT wired in
// yet — pdf-parse only pulls the embedded text layer, so a scanned/
// image-only PDF will come back with little or no text. That's a known
// gap, not a silent failure: services/document/index.js checks for a
// near-empty result and reports it as a normal "no extractable text"
// document error rather than pretending it worked. This keeps the module
// OCR-ready (Objective 6: "OCR only when needed, future-friendly") without
// adding a second AI call/cost today (Free Tier Philosophy).

// Imports the internal lib file directly, NOT the package root. pdf-parse's
// index.js has a debug harness gated on `!module.parent` that mistakenly
// activates under ESM import (module.parent is always undefined there),
// which tries to read a bundled test fixture and throws ENOENT. The actual
// parser lives at lib/pdf-parse.js with none of that wrapper.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export async function parsePdf(buffer) {
  const result = await pdfParse(buffer);
  return (result.text || '').trim();
}

export default { parsePdf };
