import { describe, expect, it } from 'vitest'
import { ASCII_GLYPHS, glyphSet, UNICODE_GLYPHS } from '../src/glyphs.ts'
import { segmentText, wrapSegments, type StyledSegment } from '../src/styling.ts'
import { displayWidth, wrapWords } from '../src/terminal-text.ts'
import { resolveTheme } from '../src/theme.ts'

const TONES = [
  'user', 'assistant', 'reasoning', 'system', 'tool', 'error',
  'diff-add', 'diff-remove', 'diff-hunk', 'code', 'heading', 'quote', 'bullet', 'badge',
] as const

describe('theme resolution', () => {
  it('emits no colour at all when the terminal refused it', () => {
    for (const theme of [resolveTheme('none'), resolveTheme('truecolor', false)]) {
      expect(theme.enabled).toBe(false)
      for (const tone of TONES) expect(theme.color(tone)).toBeUndefined()
    }
  })

  it('uses ANSI names below truecolor so the user scheme still applies', () => {
    for (const level of ['basic', 'ansi256'] as const) {
      const theme = resolveTheme(level)
      expect(theme.color('diff-add')).toBe('green')
      expect(theme.color('diff-remove')).toBe('red')
      expect(theme.color('error')).toBe('red')
    }
  })

  it('uses muted hexes on a truecolor terminal', () => {
    const theme = resolveTheme('truecolor')
    expect(theme.color('diff-add')).toMatch(/^#[0-9a-f]{6}$/)
    expect(theme.color('diff-remove')).toMatch(/^#[0-9a-f]{6}$/)
    expect(theme.color('diff-add')).not.toBe(theme.color('diff-remove'))
  })

  it('leaves assistant prose unpainted so it inherits the foreground', () => {
    for (const level of ['basic', 'truecolor'] as const) {
      expect(resolveTheme(level).color('assistant')).toBeUndefined()
    }
  })

  it('gives added and removed rows different colours, whatever the palette', () => {
    for (const level of ['basic', 'ansi256', 'truecolor'] as const) {
      const theme = resolveTheme(level)
      expect(theme.color('diff-add')).not.toBe(theme.color('diff-remove'))
    }
  })

  it('dims secondary rows even without colour', () => {
    const theme = resolveTheme('none')
    expect(theme.dim('reasoning')).toBe(true)
    expect(theme.dim('system')).toBe(true)
    expect(theme.dim('assistant')).toBe(false)
  })
})

describe('glyph sets', () => {
  it('swaps in ASCII stand-ins for a terminal that cannot draw wide glyphs', () => {
    expect(glyphSet(true)).toBe(UNICODE_GLYPHS)
    expect(glyphSet(false)).toBe(ASCII_GLYPHS)
    expect(ASCII_GLYPHS.succeeded).toBe('+')
  })

  it('keeps every status glyph one cell wide in both sets', () => {
    for (const set of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
      for (const key of ['pending', 'succeeded', 'failed', 'interrupted'] as const) {
        expect(displayWidth(set[key])).toBe(1)
      }
    }
  })
})

describe('segment wrapping', () => {
  const segments: readonly StyledSegment[] = [
    { text: 'run ' },
    { text: 'flush()', tone: 'code' },
    { text: ' and then stop' },
  ]

  it('splits a run that straddles a break, keeping its style on both halves', () => {
    const rows = wrapWords(segmentText(segments), 10)
    const styled = wrapSegments(segments, rows)
    expect(styled).toHaveLength(rows.length)
    for (const [index, row] of rows.entries()) {
      expect(segmentText(styled[index] ?? [])).toBe(row)
    }
    // The code span survives the break with its tone intact.
    expect(styled.flat().filter(part => part.tone === 'code').map(part => part.text).join(''))
      .toBe('flush()')
  })

  it('reproduces each wrapped row exactly, for any text and width', () => {
    const source: readonly StyledSegment[] = [
      { text: 'alpha beta ' },
      { text: 'gamma', bold: true },
      { text: ' delta epsilon zeta' },
    ]
    for (let columns = 4; columns <= 40; columns++) {
      const rows = wrapWords(segmentText(source), columns)
      const styled = wrapSegments(source, rows)
      expect(styled.map(row => segmentText(row))).toEqual([...rows])
    }
  })
})
