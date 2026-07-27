// ─── TXT PARSER ───────────────────────────────────────────
// Objective 6: raw text, decoded as UTF-8. No transformation needed.

export async function parseTxt(buffer) {
  return buffer.toString('utf-8').trim();
}

export default { parseTxt };
