// ─── DOCX PARSER ──────────────────────────────────────────
// Objective 6: paragraphs, tables, and headings. mammoth's raw-text
// extractor already walks paragraphs and table cells and separates them
// with newlines, which is sufficient normalized structure for the LLM —
// no need for mammoth's HTML mode (that would just add markup we'd have
// to strip back out before prompting).

import mammoth from 'mammoth';

export async function parseDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return (result.value || '').trim();
}

export default { parseDocx };
