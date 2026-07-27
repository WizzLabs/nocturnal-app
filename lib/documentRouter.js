// ─── DOCUMENT ROUTER ─────────────────────────────────────
// Sprint 6b: single responsibility module that decides what a non-image
// attached file actually is, and whether Nocturnal can do anything with
// it. Mirrors lib/visionRouter.js's shape exactly — a plain function,
// no network calls, no state — this module owns exactly one decision:
// given an attached file, which parser (if any) should run.
//
//   User → file attached → DocumentRouter.routeDocument(file) → parser key
//
// It never parses content itself (services/document/index.js owns that)
// and never decides mode/model selection.

const SUPPORTED_TYPES = {
  pdf: { exts: ['pdf'], mimes: ['application/pdf'] },
  docx: { exts: ['docx'], mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
  txt: { exts: ['txt'], mimes: ['text/plain'] },
  markdown: { exts: ['md', 'markdown'], mimes: ['text/markdown', 'text/x-markdown'] },
  xlsx: { exts: ['xlsx'], mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
};

function extOf(filename) {
  if (!filename || typeof filename !== 'string') return '';
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

// Returns a routing verdict for a document-attached request:
//   { ok: true, type }    — route to this parser key (pdf/docx/txt/markdown/xlsx)
//   { ok: false, error }  — unsupported file; caller must reject with a
//                           clear, friendly error (Objective 5)
export function routeDocument(file) {
  if (!file || !file.name) {
    return { ok: false, error: 'No file provided.' };
  }

  const ext = extOf(file.name);
  const mime = (file.type || '').toLowerCase();

  for (const [type, spec] of Object.entries(SUPPORTED_TYPES)) {
    if (spec.exts.includes(ext) || spec.mimes.includes(mime)) {
      return { ok: true, type };
    }
  }

  return {
    ok: false,
    error: `"${file.name}" isn't a supported document type. I can read PDF, DOCX, TXT, Markdown (.md), and Excel (.xlsx) files.`,
  };
}

export default { routeDocument };
