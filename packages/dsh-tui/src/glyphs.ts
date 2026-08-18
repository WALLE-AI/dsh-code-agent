/**
 * Glyph sets.
 *
 * The transcript's status markers used to be hardcoded box-drawing characters,
 * shipped unconditionally even though the capability probe already knew the
 * terminal could not place them. A console that cannot render `▸` shows a
 * replacement box, which reads as corruption; an ASCII stand-in reads as a
 * deliberate choice.
 */

export interface GlyphSet {
  readonly pending: string
  readonly succeeded: string
  readonly failed: string
  readonly interrupted: string
  readonly user: string
  readonly reasoning: string
  readonly marker: string
  readonly rule: string
  readonly fold: string
  /** Assistant paragraph marker. */
  readonly bullet: string
  /** Reasoning marker; distinct from the assistant's so folds read differently. */
  readonly thinking: string
  /** Tool-card body gutter: first row, then the alignment for the rest. */
  readonly gutterFirst: string
  readonly gutterRest: string
  /** Markdown list marker, replacing whichever of `-`, `*`, `+` was written. */
  readonly listBullet: string
  /** Markdown block-quote marker, replacing `>`. */
  readonly quoteBar: string
  /** Rendered-table parts: the column separator, its rule, and their joint. */
  readonly tableColumn: string
  readonly tableRow: string
  readonly tableCross: string
}

export const UNICODE_GLYPHS: GlyphSet = Object.freeze({
  pending: '▸',
  succeeded: '✓',
  failed: '✗',
  interrupted: '⚠',
  user: '>',
  reasoning: '~',
  marker: '•',
  rule: '──',
  fold: '…',
  bullet: '●',
  thinking: '∴',
  gutterFirst: ' ⎿ ',
  gutterRest: '   ',
  listBullet: '•',
  quoteBar: '│',
  tableColumn: '│',
  tableRow: '─',
  tableCross: '┼',
})

export const ASCII_GLYPHS: GlyphSet = Object.freeze({
  pending: '>',
  succeeded: '+',
  failed: 'x',
  interrupted: '!',
  user: '>',
  reasoning: '~',
  marker: '*',
  rule: '--',
  fold: '...',
  bullet: '*',
  thinking: '~',
  gutterFirst: ' \\ ',
  gutterRest: '   ',
  listBullet: '-',
  quoteBar: '|',
  tableColumn: '|',
  tableRow: '-',
  tableCross: '+',
})

/** All glyphs are one cell wide in either set, so row budgets are unaffected. */
export function glyphSet(unicode: boolean): GlyphSet {
  return unicode ? UNICODE_GLYPHS : ASCII_GLYPHS
}
