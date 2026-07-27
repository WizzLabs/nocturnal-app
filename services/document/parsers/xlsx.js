// ─── EXCEL PARSER ─────────────────────────────────────────
// Objective 6: "Read sheets, preserve table structure, extract cell
// values." Each sheet becomes a "## Sheet: <name>" section followed by a
// CSV rendering of its cells — CSV keeps row/column alignment (table
// structure) in a compact, LLM-friendly text form without the overhead
// of a full JSON grid.

import * as XLSX from 'xlsx';

export async function parseXlsx(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  const sections = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet).trim();
    return `## Sheet: ${sheetName}\n${csv || '(empty sheet)'}`;
  });

  return sections.join('\n\n').trim();
}

export default { parseXlsx };
