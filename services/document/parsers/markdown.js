// ─── MARKDOWN PARSER ──────────────────────────────────────
// Objective 6: "Preserve headings, preserve code blocks." Markdown source
// already IS that structure in plain text form — headings are `#` lines,
// code blocks are fenced with ``` — so passing it through unmodified
// preserves everything the spec asks for. No markdown-to-HTML/AST
// conversion; that would only add work and risk losing exact code-block
// content, which is the opposite of what Objective 6 wants here.

export async function parseMarkdown(buffer) {
  return buffer.toString('utf-8').trim();
}

export default { parseMarkdown };
