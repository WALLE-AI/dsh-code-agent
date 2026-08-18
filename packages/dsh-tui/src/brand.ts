/**
 * DeepSeek brand art for the startup banner.
 *
 * The whale sprite and the block-font glyph table are reused from the
 * `dsh-TUI` project (MIT, (c) 2026 chimney) — see `THIRD_PARTY_NOTICES.md`.
 * Only the data is reused: their renderers are built on a forked Ink and could
 * not be used here, so the two painters below are ours and emit the same
 * `DetailLine`/`StyledSegment` rows as everything else in the transcript.
 *
 * Art degrades before it misleads. The sprite needs both half-block glyphs and
 * colour to read as anything at all — without either it is a grey slab — so a
 * terminal that lacks one simply does not get it, and the banner falls back to
 * text. That is also what keeps the no-colour smoke honest.
 */

import type { ColorLevel } from './terminal-capabilities.ts'
import type { DetailLine, StyledSegment } from './styling.ts'

/**
 * Sprite palette: `D` outline, `B` body, `L` belly, `W` mouth, `.`
 * transparent. Two vertical pixels share one cell, so the 40x25 sprite paints
 * as 40 columns by 13 rows with roughly square pixels.
 */
const WHALE: readonly string[] = [
  '........................................',
  '........................................',
  '........................D...............',
  '.......................DBD.......D......',
  '.......................DBBD.....DBD.....',
  '.......................DBBBD..DDBBD.....',
  '.......................DBBBBDDBBBBD.....',
  '.......DDDDDDDDD........DBBBBBBBBD......',
  '......DBBBBBBBBBDD.......DBBBBBBBD......',
  '.....DBBBBBBBBBBBBDD.....DBBBBBDD.......',
  '....DBBBBBBBBBBBBBBBDD....DBBBD.........',
  '...DDBBBBBBBBBBBBBBBBBD..DBBBBD.........',
  '...DBBBBBBBBBBBBBBBBBBBDDBBBBBD.........',
  '...DBBBDBBBBBBDBBBBBBBBBBBBBBBD.........',
  '...DBBBDBBBBBBDBBBBBBBBBBBBBBD..........',
  '...DBBBBBBBBBBBBBBBBBBBBBBBBBD..........',
  '...DBBBBWWWWWWWBBBBBBBBDBBBBD...........',
  '...DDBWWWWWWWWWWWWBBBBBBDBBBD...........',
  '....DLLWWWWWWWWWWWWDBBBBDDBD............',
  '.....DLLLWWWWWWWWWWDBBBBBDD.............',
  '......DDLLLWWWWWWLLLDBBBBBDD............',
  '........DLLLLLLLLLLLDDBBBBBBD...........',
  '.........DDDDDDDDDDD..DDDDDDD...........',
  '........................................',
  '........................................',
]

/** Columns the sprite occupies; narrower terminals do not get it. */
export const WHALE_COLUMNS = 40

type Tone = 'D' | 'B' | 'L' | 'W'
type Palette = Readonly<Record<Tone, string>>

/** Deep navy outline, DeepSeek blue body, ice belly, white mouth. */
const TRUECOLOR: Palette = Object.freeze({
  D: '#142660', B: '#4e6fff', L: '#bee1ff', W: '#ffffff',
})

/**
 * Sixteen-colour fallback. The outline and the body must stay distinguishable
 * or the whale loses its edge, so they take the dim and bright blues rather
 * than two shades the terminal may render identically.
 */
const BASIC: Palette = Object.freeze({
  D: 'blue', B: 'blueBright', L: 'cyan', W: 'white',
})

/** Upper half-block: foreground paints the top pixel, background the bottom. */
const UPPER = '\u2580'
/**
 * Lower half-block, for a cell whose top pixel is transparent. Painting that
 * cell as `UPPER` with only a background would draw its top half in the
 * terminal's default foreground \u2014 the grey speckle that used to trim the
 * whale's outline wherever the sprite met empty space.
 */
const LOWER = '\u2584'

function paletteFor(colorLevel: ColorLevel): Palette | undefined {
  if (colorLevel === 'truecolor') return TRUECOLOR
  if (colorLevel === 'none') return undefined
  return BASIC
}

/**
 * Paint the sprite as half-block rows.
 *
 * Each output row folds two sprite rows into one line of `UPPER` glyphs whose
 * foreground is the upper pixel and background the lower. Cells that share a
 * colour pair are merged into one segment, which keeps a 40x13 whale to a few
 * dozen segments instead of 520.
 *
 * @returns an empty array when the terminal cannot show it (no colour, or no
 *   half-block glyphs), so the caller can fall back without a special case.
 */
export function whaleRows(colorLevel: ColorLevel, unicode: boolean): readonly DetailLine[] {
  const palette = paletteFor(colorLevel)
  if (palette === undefined || !unicode) return []
  const out: DetailLine[] = []
  for (let top = 0; top < WHALE.length; top += 2) {
    const upper = WHALE[top] ?? ''
    const lower = WHALE[top + 1] ?? ''
    const segments: StyledSegment[] = []
    for (let column = 0; column < WHALE_COLUMNS; column++) {
      const above = upper[column] ?? '.'
      const below = lower[column] ?? '.'
      // A cell with nothing in either pixel is a space, not a coloured block:
      // painting transparency would box the whale in a rectangle.
      // Only the pixels that exist are painted: a half-block carries one colour
      // in its foreground and one in its background, so a cell with a single
      // pixel takes the block that sits on that half and no background at all.
      const cell: StyledSegment = above === '.' && below === '.'
        ? { text: ' ' }
        : above === '.'
          ? { text: LOWER, color: palette[below as Tone] }
          : below === '.'
            ? { text: UPPER, color: palette[above as Tone] }
            : {
              text: UPPER,
              color: palette[above as Tone],
              background: palette[below as Tone],
            }
      const previous = segments.at(-1)
      if (previous !== undefined
        && previous.color === cell.color && previous.background === cell.background) {
        segments[segments.length - 1] = { ...previous, text: previous.text + cell.text }
        continue
      }
      segments.push(cell)
    }
    // Trailing transparency is just padding; dropping it keeps rows short.
    const last = segments.at(-1)
    if (last !== undefined && last.color === undefined && last.background === undefined) {
      segments.pop()
    }
    if (segments.length > 0) out.push({ text: segments.map(s => s.text).join(''), segments })
  }
  return out
}

/**
 * Five-row block font, reused from `dsh-TUI` (MIT). Glyphs are five columns
 * wide so curves and diagonals stay legible; only the letters the wordmark
 * needs exist, and anything else falls back to a hollow box so a typo shows up
 * instead of crashing the banner.
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  D: ['█▀▀▀▄', '█···█', '█···█', '█···█', '█▄▄▄▀'],
  E: ['█▀▀▀▀', '█····', '█▀▀▀·', '█····', '█▄▄▄▄'],
  P: ['█▀▀▀▄', '█···█', '█▄▄▄▀', '█····', '█····'],
  S: ['█▀▀▀▀', '█····', '·▀▀▀▄', '····█', '█▄▄▄▀'],
  K: ['█···█', '█·█··', '██···', '█·█··', '█···█'],
  H: ['█···█', '█···█', '█▀▀▀█', '█···█', '█···█'],
  A: ['·▄▀▄·', '█···█', '█▀▀▀█', '█···█', '█···█'],
  R: ['█▀▀▀▄', '█···█', '█▄▄▄▀', '█·█··', '█···█'],
  N: ['█···█', '██··█', '█·█·█', '█··██', '█···█'],
})

const FALLBACK: readonly string[] = ['▄▄▄▄▄', '█···█', '█···█', '█···█', '▀▀▀▀▀']

/** Five glyph columns plus one of kerning. */
const ADVANCE = 6
const GLYPH_ROWS = 5

function lerp(from: readonly number[], to: readonly number[], ratio: number): string {
  const channel = (index: number): number => Math.round(
    (from[index] ?? 0) + ((to[index] ?? 0) - (from[index] ?? 0)) * ratio,
  )
  return `#${[0, 1, 2].map(index => channel(index).toString(16).padStart(2, '0')).join('')}`
}

/** Brand blue on the left, ice blue on the right. */
const GRADIENT_FROM = [78, 111, 255]
const GRADIENT_TO = [190, 225, 255]

/**
 * Paint a word in the block font, left-to-right gradient.
 *
 * The gradient is a function of the column, not of the glyph, so the ramp is
 * continuous across letters instead of restarting at each one. Below truecolor
 * there is no ramp to speak of, so the whole wordmark takes a single colour —
 * a 16-colour terminal would quantise every step to the same blue anyway.
 *
 * @returns an empty array when the word needs more columns than the terminal
 *   has, or when the terminal has no colour or no block glyphs.
 */
export function wordmarkRows(
  word: string,
  columns: number,
  colorLevel: ColorLevel,
  unicode: boolean,
): readonly DetailLine[] {
  const letters = [...word.toUpperCase()]
  const width = letters.length * ADVANCE - 1
  if (colorLevel === 'none' || !unicode || letters.length === 0 || width > columns) return []
  const truecolor = colorLevel === 'truecolor'
  const out: DetailLine[] = []
  for (let row = 0; row < GLYPH_ROWS; row++) {
    const segments: StyledSegment[] = []
    for (const [index, letter] of letters.entries()) {
      const glyph = (GLYPHS[letter] ?? FALLBACK)[row] ?? ''
      for (const [offset, cell] of [...glyph].entries()) {
        // `·` is a hole in the glyph, and holes carry no colour.
        const text = cell === '·' ? ' ' : cell
        const column = index * ADVANCE + offset
        const color = cell === '·' ? undefined
          : truecolor ? lerp(GRADIENT_FROM, GRADIENT_TO, width <= 1 ? 0 : column / (width - 1))
            : 'blueBright'
        const previous = segments.at(-1)
        if (previous !== undefined && previous.color === color) {
          segments[segments.length - 1] = { ...previous, text: previous.text + text }
          continue
        }
        segments.push({ text, ...(color === undefined ? {} : { color }) })
      }
      if (index < letters.length - 1) segments.push({ text: ' ' })
    }
    out.push({ text: segments.map(segment => segment.text).join(''), segments })
  }
  return out
}
