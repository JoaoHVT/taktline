/**
 * clipboardGrid — the TSV shape spreadsheets put on the clipboard.
 *
 * Excel and Google Sheets exchange a rectangular block as tab-separated values: cells
 * split on TAB, rows on newline, and any cell containing a tab/newline/quote wrapped in
 * double quotes with "" escaping. Reading and writing exactly that shape is what makes a
 * copied row paste back into its own columns instead of collapsing into a single cell.
 *
 * Pure string helpers — no React, no DOM — so the grid and any future consumer share one
 * implementation.
 */

/** Parse a clipboard TSV block into a grid of raw cell strings. */
export function parseTsv(text: string): string[][] {
  const grid: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ }   // "" ⇒ literal quote
        else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"' && cell === '') { quoted = true; continue }
    if (ch === '\t') { row.push(cell); cell = ''; continue }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++      // CRLF ⇒ one break
      row.push(cell); grid.push(row); row = []; cell = ''
      continue
    }
    cell += ch
  }
  // A trailing newline ends the last row and adds nothing; anything still pending is a
  // final cell of a final row.
  if (cell !== '' || row.length) { row.push(cell); grid.push(row) }
  return grid
}

/** Serialize a grid of cell strings into a clipboard TSV block. */
export function toTsv(grid: string[][]): string {
  return grid
    .map(r => r.map(v => (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join('\t'))
    .join('\n')
}
