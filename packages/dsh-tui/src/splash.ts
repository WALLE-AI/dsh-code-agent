/**
 * Startup banner.
 *
 * Shown once at the top of a fresh transcript and then left to scroll away with
 * the rest of the history — it is a greeting, not a permanent header, so it
 * must not hold rows on every frame.
 *
 * It only states what the session actually knows. A model line appears when the
 * run was given one; there is no placeholder for facts the profile has not been
 * told, because a confident wrong value is worse than a missing line.
 */

import { WHALE_COLUMNS, whaleRows, wordmarkRows } from './brand.ts'
import type { GlyphSet } from './glyphs.ts'
import type { DetailLine } from './styling.ts'
import type { ColorLevel } from './terminal-capabilities.ts'
import { truncateToWidth } from './terminal-text.ts'

/** Below this the frame is dropped and only the title survives. */
const FRAME_MIN_COLUMNS = 44

/** The wordmark this banner spells out in the block font. */
const WORDMARK = 'deepseek'

export interface SplashFacts {
  readonly title: string
  /** Model route, when the run was started with one. */
  readonly model?: string
  readonly directory?: string
  readonly branch?: string
  readonly tips: readonly string[]
}

function frame(title: string, columns: number, unicode: boolean): readonly DetailLine[] {
  const inner = Math.min(columns - 4, Math.max(title.length + 2, 28))
  const pad = ' '.repeat(Math.max(0, inner - title.length - 1))
  const [tl, tr, bl, br, h, v] = unicode
    ? ['╭', '╮', '╰', '╯', '─', '│']
    : ['+', '+', '+', '+', '-', '|']
  const rule = h.repeat(inner)
  return [
    { text: `${tl}${rule}${tr}`, tone: 'heading' },
    { text: `${v} ${title}${pad}${v}`, tone: 'heading' },
    { text: `${bl}${rule}${br}`, tone: 'heading' },
  ]
}

/**
 * Build the banner rows.
 *
 * The brand art leads, when the terminal can carry it. It is the one place the
 * banner spends rows on decoration, and it earns them only once: this is a
 * transcript entry, so it scrolls away and costs nothing on later frames.
 *
 * @param columns - terminal width; a narrow terminal loses the art first, then
 *   the frame, then the tips, and finally keeps only the title.
 * @param colorLevel - the art is dropped entirely below `basic`; a whale with
 *   no colours is a grey slab, not a whale.
 */
export function buildSplash(
  facts: SplashFacts,
  columns: number,
  glyphs: GlyphSet,
  colorLevel: ColorLevel = 'none',
): readonly DetailLine[] {
  if (columns <= 0) return []
  const unicode = glyphs.rule !== '--'
  const art: DetailLine[] = []
  if (columns >= WHALE_COLUMNS) art.push(...whaleRows(colorLevel, unicode))
  art.push(...wordmarkRows(WORDMARK, columns, colorLevel, unicode))
  // A blank row only earns its place when there is art above it to separate.
  if (art.length > 0) art.push({ text: '' })
  const rows: DetailLine[] = [
    ...art,
    ...columns >= FRAME_MIN_COLUMNS
      ? frame(facts.title, columns, unicode)
      : [{ text: facts.title, tone: 'heading' as const }],
  ]

  const where = [facts.directory, facts.branch]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(` ${glyphs.marker} `)
  if (facts.model !== undefined) rows.push({ text: facts.model, tone: 'badge' })
  if (where !== '') rows.push({ text: where, tone: 'system' })
  // Tips are the first thing to go: they are the least durable information here.
  if (facts.tips.length > 0 && columns >= FRAME_MIN_COLUMNS) {
    rows.push({ text: `Tip: ${facts.tips.join(` ${glyphs.marker} `)}`, tone: 'system' })
  }
  // Styled rows are already built to fit and are left alone: truncating one
  // would shorten `text` while its segments still spelled the original, and
  // every consumer assumes those two agree.
  return rows.map(row => row.segments === undefined
    ? { ...row, text: truncateToWidth(row.text, columns) }
    : row)
}
