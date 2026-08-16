/**
 * Terminal text safety and width. Model output, tool output, and repository
 * content are untrusted: only the TUI itself may emit styling sequences.
 */

const ESCAPE = 0x1b
const BELL = 0x07
const NEWLINE = 0x0a
const TAB = 0x09
const TAB_WIDTH = 4

/** Ranges rendered two columns wide by conforming terminals. */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]

/** Ranges that combine with the previous cell and therefore occupy no column. */
const ZERO: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06dc], [0x0730, 0x074a],
  [0x07a6, 0x07b0], [0x0900, 0x0903], [0x093a, 0x094f], [0x0951, 0x0957],
  [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200d, 0x200d], [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xe0100, 0xe01ef],
]

/** Invisible marks that can hide or reorder text without occupying a cell. */
const SPOOFING: readonly (readonly [number, number])[] = [
  [0x200b, 0x200c], [0x200e, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
]

function inRanges(code: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [start, end] of ranges) {
    if (code < start) return false
    if (code <= end) return true
  }
  return false
}

/** Columns occupied by one code point. */
export function codePointWidth(code: number): number {
  if (inRanges(code, ZERO)) return 0
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0
  return inRanges(code, WIDE) ? 2 : 1
}

/** Index of the last character belonging to the escape sequence at `start`. */
function endOfEscape(text: string, start: number): number {
  const next = text.charCodeAt(start + 1)
  if (Number.isNaN(next)) return start
  // CSI: parameter bytes, then intermediate bytes, then one final byte.
  if (next === 0x5b) {
    let index = start + 2
    while (index < text.length && text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x3f) index++
    while (index < text.length && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x2f) index++
    return Math.min(index, text.length - 1)
  }
  // OSC, DCS, PM, APC, SOS: terminated by BEL or by ST, otherwise unterminated.
  if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f || next === 0x58) {
    let index = start + 2
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (code === BELL) return index
      if (code === ESCAPE && text.charCodeAt(index + 1) === 0x5c) return index + 1
      index++
    }
    return text.length - 1
  }
  return start + 1
}

function dropped(code: number): boolean {
  if (code === NEWLINE) return false
  if (code < 0x20 || code === 0x7f) return true
  if (code >= 0x80 && code <= 0x9f) return true
  return inRanges(code, SPOOFING)
}

/** Remove escape sequences, control characters, and invisible spoofing marks. */
export function sanitizeText(text: string): string {
  let result = ''
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === ESCAPE) {
      index = endOfEscape(text, index)
      continue
    }
    if (code === TAB) {
      result += ' '.repeat(TAB_WIDTH)
      continue
    }
    if (code === 0x0d) {
      // Normalize CRLF and bare CR so a carriage return cannot overwrite a row.
      if (text.charCodeAt(index + 1) === NEWLINE) index++
      result += '\n'
      continue
    }
    if (dropped(code)) continue
    result += text[index]
  }
  return result
}

/** Sanitize and collapse to a single terminal row. */
export function sanitizeLine(text: string): string {
  return sanitizeText(text).replace(/\n/g, ' ')
}

/** Terminal columns needed by an already-sanitized string. */
export function displayWidth(text: string): number {
  let width = 0
  for (const character of text) width += codePointWidth(character.codePointAt(0) ?? 0)
  return width
}

/** Cut a sanitized string to `columns`, never splitting a wide cell in half. */
export function truncateToWidth(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (displayWidth(text) <= columns) return text
  const budget = columns > 1 ? columns - 1 : columns
  let width = 0
  let cut = ''
  for (const character of text) {
    const next = codePointWidth(character.codePointAt(0) ?? 0)
    if (width + next > budget) break
    width += next
    cut += character
  }
  return columns > 1 ? `${cut}…` : cut
}

/** Hard-wrap a sanitized string into rows of at most `columns` cells. */
export function wrapToWidth(text: string, columns: number): readonly string[] {
  if (columns <= 0) return ['']
  const rows: string[] = []
  for (const line of text.split('\n')) {
    let width = 0
    let row = ''
    for (const character of line) {
      const next = codePointWidth(character.codePointAt(0) ?? 0)
      // A cell wider than the whole row can never be rendered; standing in for
      // it keeps every row inside the budget instead of overflowing by one cell.
      const cell = next > columns ? '…' : character
      const cellWidth = next > columns ? 1 : next
      if (width + cellWidth > columns) {
        rows.push(row)
        width = 0
        row = ''
      }
      width += cellWidth
      row += cell
    }
    rows.push(row)
  }
  return rows
}
