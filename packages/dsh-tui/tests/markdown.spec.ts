import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isPlainText, renderMarkdown, styleInline } from '../src/markdown.ts'
import { segmentText } from '../src/styling.ts'

function tones(source: string): readonly (string | undefined)[] {
  return renderMarkdown(source).map(line => line.segments[0]?.tone)
}

describe('inline styling', () => {
  it('styles code spans and bold runs', () => {
    // Delimiters are kept: the segments must still sum to the source row.
    expect(styleInline('call `flush()` then **stop**')).toEqual([
      { text: 'call ' },
      { text: '`flush()`', tone: 'code' },
      { text: ' then ' },
      { text: '**stop**', bold: true },
    ])
  })

  it('leaves an unmatched delimiter as literal text', () => {
    // Mid-stream this is a fence that has not finished arriving, not an error.
    expect(styleInline('an unclosed `span')).toEqual([{ text: 'an unclosed `span' }])
    expect(styleInline('half **bold')).toEqual([{ text: 'half **bold' }])
  })

  it('returns one empty segment for an empty line', () => {
    expect(styleInline('')).toEqual([{ text: '' }])
  })
})

describe('block styling', () => {
  it('holds code tone for every line inside a fence', () => {
    expect(tones('before\n```ts\nconst a = 1\n\n```\nafter'))
      .toEqual([undefined, 'code', 'code', 'code', 'code', undefined])
  })

  it('treats an unterminated fence as code to the end', () => {
    expect(tones('```\nstill streaming')).toEqual(['code', 'code'])
  })

  it('marks headings, quotes, and list markers', () => {
    expect(tones('## Title')).toEqual(['heading'])
    expect(tones('> quoted')).toEqual(['quote'])
    expect(tones('- item')).toEqual(['bullet'])
    expect(tones('1. item')).toEqual(['bullet'])
  })

  it('styles the text of a list item but not its marker', () => {
    expect(renderMarkdown('- run `flush()`')[0]?.segments).toEqual([
      { text: '- ', tone: 'bullet' },
      { text: 'run ' },
      { text: '`flush()`', tone: 'code' },
    ])
  })

  it('does not swallow markup a heading or fence line contains', () => {
    // The hashes stay, so the row's width matches its plain text exactly.
    expect(segmentText(renderMarkdown('# A `code` title')[0]?.segments ?? []))
      .toBe('# A `code` title')
  })
})

describe('cost guards', () => {
  it('detects text with nothing to style', () => {
    expect(isPlainText('just some ordinary prose, nothing special')).toBe(true)
    expect(isPlainText('some `code`')).toBe(false)
    expect(isPlainText('- a list')).toBe(false)
  })

  it('passes plain prose straight through, one segment per line', () => {
    const rendered = renderMarkdown('first line\nsecond line')
    expect(rendered).toEqual([
      { segments: [{ text: 'first line' }] },
      { segments: [{ text: 'second line' }] },
    ])
  })

  it('gives up on a message too long to be worth scanning', () => {
    const huge = `**bold**\n`.repeat(4_000)
    const rendered = renderMarkdown(huge)
    // Untouched: every line is one plain segment carrying its source.
    expect(rendered[0]).toEqual({ segments: [{ text: '**bold**' }] })
  })
})

describe('round-trip invariant', () => {
  it('preserves the source exactly, line for line', () => {
    // A lone code span is what first broke this: the delimiters were consumed.
    expect(segmentText(renderMarkdown('` `')[0]?.segments ?? [])).toBe('` `')
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (source) => {
      const rendered = renderMarkdown(source)
      const lines = source.split('\n')
      expect(rendered).toHaveLength(lines.length)
      for (const [index, line] of lines.entries()) {
        expect(segmentText(rendered[index]?.segments ?? [])).toBe(line)
      }
    }), { numRuns: 2_000 })
  })
})
