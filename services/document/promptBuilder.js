// ─── DOCUMENT PROMPT BUILDER ──────────────────────────────
// Sprint 6b Objective 7: builds the internal grounding instruction handed
// to the currently-selected chat model (Flash/Insight/Abyss) — mirrors
// services/vision/promptBuilder.js's buildGroundedPrompt exactly. Pure
// string assembly, no network calls.

const TYPE_LABELS = {
  pdf: 'PDF',
  docx: 'DOCX',
  txt: 'TXT',
  markdown: 'Markdown',
  xlsx: 'Excel',
};

export function buildGroundedPrompt({ question, docType, fileName, text, truncated }) {
  const typeLabel = TYPE_LABELS[docType] || docType;
  const truncationNote = truncated
    ? `\n(Note: this document was long and has been truncated — if the user's question may depend on content beyond what's shown, say so rather than guessing.)`
    : '';

  return `The user uploaded a document.

Document type:

${typeLabel}${fileName ? ` (${fileName})` : ''}

Extracted content:

${text}
${truncationNote}

The user asked:

"${question}"

Answer only using the document contents, EXCEPT when the user has explicitly corrected or updated something the document says (e.g. the document says "my project is a portfolio" but the user later said "my project is an AI") — an explicit statement from the user in this conversation always takes priority over the document on that specific point. Do not invent information not present in the file or the conversation. Answer naturally in your normal voice and format for this mode — do not mention "extracted content" or that this text was structured/passed to you, just answer as if you read the document yourself. If the document doesn't contain what the user asked about, say so plainly instead of guessing.`;
}

export default { buildGroundedPrompt };
