import { describe, expect, it } from 'vitest'
import { WHALE_COLUMNS, whaleRows, wordmarkRows } from '../src/brand.ts'
import { segmentText } from '../src/styling.ts'
import { displayWidth } from '../src/terminal-text.ts'

describe('whale sprite', () => {
  it('paints two sprite rows per terminal row, within the sprite width', () => {
    const rows = whaleRows('truecolor', true)
    expect(rows.length).toBeGreaterThan(0)
    // 25 sprite rows fold to 13 pairs; the blank ones at top and bottom are
    // dropped rather than emitted as rows of coloured nothing.
    expect(rows.length).toBeLessThanOrEqual(13)
    for (const row of rows) {
      expect(displayWidth(row.text)).toBeLessThanOrEqual(WHALE_COLUMNS)
      expect(segmentText(row.segments ?? [])).toBe(row.text)
    }
  })

  it('never emits a coloured cell for a transparent pixel', () => {
    for (const row of whaleRows('truecolor', true)) {
      for (const segment of row.segments ?? []) {
        if (segment.color === undefined && segment.background === undefined) {
          expect(segment.text.trim()).toBe('')
        }
      }
    }
  })

  it('never leaves half a cell in the terminal default colour', () => {
    // A half-block paints its other half with the background. A cell that has
    // only one pixel must therefore take the block sitting on that half and no
    // background at all — an upper block with a background only would draw its
    // top in whatever foreground the terminal happens to have, which speckled
    // grey along every edge where the whale met empty space.
    for (const row of whaleRows('truecolor', true)) {
      for (const segment of row.segments ?? []) {
        if (segment.background !== undefined) expect(segment.color).toBeDefined()
      }
    }
  })

  it('drops the art when the terminal cannot carry it', () => {
    // Without colour it is a slab of half-blocks; without half-blocks there is
    // nothing to paint at all. Either way the banner falls back to text.
    expect(whaleRows('none', true)).toEqual([])
    expect(whaleRows('truecolor', false)).toEqual([])
  })

  it('keeps outline and body distinguishable on a 16-colour terminal', () => {
    const colors = new Set(
      whaleRows('basic', true).flatMap(row => (row.segments ?? []).map(s => s.color)),
    )
    colors.delete(undefined)
    expect(colors.size).toBeGreaterThan(1)
    // Named colours, not hex: a 16-colour terminal would quantise hex anyway,
    // and the names respect the user's own scheme.
    for (const color of colors) expect(color).not.toMatch(/^#/)
  })
})

describe('block wordmark', () => {
  it('paints five rows whose segments sum to the row text', () => {
    const rows = wordmarkRows('deepseek', 80, 'truecolor', true)
    expect(rows).toHaveLength(5)
    for (const row of rows) expect(segmentText(row.segments ?? [])).toBe(row.text)
  })

  it('ramps the gradient across the whole word, not per letter', () => {
    const rows = wordmarkRows('deepseek', 80, 'truecolor', true)
    const colors = (rows[0]?.segments ?? [])
      .map(segment => segment.color)
      .filter((color): color is string => color !== undefined)
    // A per-letter ramp would repeat its first colour once per letter.
    expect(new Set(colors).size).toBe(colors.length)
    expect(colors[0]).toBe('#4e6fff')
    expect(colors.at(-1)).toBe('#bee1ff')
  })

  it('takes one colour below truecolor', () => {
    const colors = new Set((wordmarkRows('deepseek', 80, 'ansi256', true)[0]?.segments ?? [])
      .map(segment => segment.color)
      .filter(color => color !== undefined))
    expect([...colors]).toEqual(['blueBright'])
  })

  it('refuses to paint a word wider than the terminal', () => {
    // Eight letters at six columns each, less the final kerning column.
    expect(wordmarkRows('deepseek', 47, 'truecolor', true)).toHaveLength(5)
    expect(wordmarkRows('deepseek', 46, 'truecolor', true)).toEqual([])
  })

  it('shows an unknown letter as a hollow box instead of failing', () => {
    const rows = wordmarkRows('z', 20, 'truecolor', true)
    expect(rows).toHaveLength(5)
    expect(rows[0]?.text).toBe('▄▄▄▄▄')
  })
})
