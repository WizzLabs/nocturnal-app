// ─── DOCUMENT SERVICE ─────────────────────────────────────
// Sprint 6b: turns an attached, non-image file into normalized text.
//
//   file → DocumentRouter (type) → parser → normalized text → Prompt Builder
//
// Mirrors services/vision/index.js conventions exactly: a plain async
// function, never throws — callers get { ok: true, text } or
// { ok: false, error } and are responsible for failing gracefully.
// server.js never sees raw parser exceptions.

import { parsePdf } from './parsers/pdf.js';
import { parseDocx } from './parsers/docx.js';
import { parseTxt } from './parsers/txt.js';
import { parseMarkdown } from './parsers/markdown.js';
import { parseXlsx } from './parsers/xlsx.js';

const PARSERS = {
  pdf: parsePdf,
  docx: parseDocx,
  txt: parseTxt,
  markdown: parseMarkdown,
  xlsx: parseXlsx,
};

// Free Tier Philosophy: cap extracted text before it ever reaches the
// prompt builder, so one huge document can't blow up token usage on a
// single request. Generous enough for real documents, cheap to enforce.
const MAX_EXTRACTED_CHARS = 20000;

function decodeDataUrl(dataUrl) {
  // "data:<mime>;base64,<data>" — same shape the frontend already sends
  // for images (FileReader.readAsDataURL), so no new client contract.
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) return null;
  return Buffer.from(dataUrl.slice(commaIndex + 1), 'base64');
}

// file: { name, type, data } — data is a base64 data URL.
// type: parser key resolved by lib/documentRouter.js.
export async function extractText({ file, type }) {
  console.log('[Document] File received');
  console.log(`[Document] Type: ${type}`);

  const parser = PARSERS[type];
  if (!parser) {
    return { ok: false, error: 'unsupported_type' };
  }

  const buffer = decodeDataUrl(file.data || '');
  if (!buffer || buffer.length === 0) {
    return { ok: false, error: 'empty_file' };
  }

  console.log('[Document] Parsing...');
  try {
    let text = await parser(buffer);
    text = (text || '').trim();

    if (!text) {
      console.warn('[Document] No extractable text found');
      return { ok: false, error: 'no_text' };
    }

    let truncated = false;
    if (text.length > MAX_EXTRACTED_CHARS) {
      text = text.slice(0, MAX_EXTRACTED_CHARS);
      truncated = true;
    }

    console.log('[Document] Extraction complete');
    return { ok: true, text, truncated };
  } catch (err) {
    console.warn('[Document] Parsing failed:', err.message);
    return { ok: false, error: 'parse_error' };
  }
}

export default { extractText };
