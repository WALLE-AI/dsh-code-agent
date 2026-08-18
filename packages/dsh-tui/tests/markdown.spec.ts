import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ASCII_GLYPHS } from '../src/glyphs.ts'
import { isPlainText, renderMarkdown, styleInline } from '../src/markdown.ts'
import { segmentText } from '../src/styling.ts'
import { displayWidth } from '../src/terminal-text.ts'

function tones(source: string): readonly (string | undefined)[] {
  return renderMarkdown(source).map(line => line.segments[0]?.tone)
}

function texts(source: string): readonly string[] {
  return renderMarkdown(source).map(line => line.text)
}

describe('inline rendering', () => {
  it('styles code spans and bold runs, consuming their delimiters', () => {
    expect(styleInline('call `flush()` then **stop**')).toEqual([
      { text: 'call ' },
      { text: 'flush()', tone: 'code' },
      { text: ' then ' },
      { text: 'stop', bold: true },
    ])
  })

  it('styles italics, strikethrough and links', () => {
    expect(styleInline('*maybe*')).toEqual([{ text: 'maybe', italic: true }])
    expect(styleInline('_maybe_')).toEqual([{ text: 'maybe', italic: true }])
    expect(styleInline('~~gone~~')).toEqual([{ text: 'gone', strikethrough: true }])
    expect(styleInline('see [the guide](https://example.com/g)')).toEqual([
      { text: 'see ' },
      { text: 'the guide' },
      { text: ' (https://example.com/g)', tone: 'quote' },
    ])
  })

  it('leaves an underscore inside a word alone', () => {
    // `read_image` and `str_replace_editor` are tool names, not emphasis.
    expect(styleInline('read_image and str_replace_editor'))
      .toEqual([{ text: 'read_image and str_replace_editor' }])
  })

  it('styles one level of nesting inside a bold run', () => {
    expect(styleInline('**run `flush()` now**')).toEqual([
      { text: 'run ', bold: true },
      { text: 'flush()', tone: 'code', bold: true },
      { text: ' now', bold: true },
    ])
  })

  it('does not read a bold run as two italics', () => {
    expect(styleInline('**stop**')).toEqual([{ text: 'stop', bold: true }])
  })

  it('leaves markup inside a code span literal', () => {
    expect(styleInline('`**not bold**`')).toEqual([{ text: '**not bold**', tone: 'code' }])
  })

  it('leaves an unmatched delimiter as literal text', () => {
    // Mid-stream this is a construct that has not finished arriving, not an error.
    expect(styleInline('an unclosed `span')).toEqual([{ text: 'an unclosed `span' }])
    expect(styleInline('half **bold')).toEqual([{ text: 'half **bold' }])
  })

  it('returns one empty segment for an empty line', () => {
    expect(styleInline('')).toEqual([{ text: '' }])
  })
})

describe('block rendering', () => {
  it('holds code tone for every line inside a fence', () => {
    expect(tones('before\n```ts\nconst a = 1\n\n```\nafter'))
      .toEqual([undefined, 'code', 'code', 'code', 'code', undefined])
  })

  it('shows a fence as a rule carrying the language, not three backticks', () => {
    expect(texts('```ts\nconst a = 1\n```')).toEqual(['─── ts', 'const a = 1', '───'])
  })

  it('treats an unterminated fence as code to the end', () => {
    expect(tones('```\nstill streaming')).toEqual(['code', 'code'])
  })

  it('drops heading hashes and quote markers, keeping the tone', () => {
    expect(texts('## Title')).toEqual(['Title'])
    expect(tones('## Title')).toEqual(['heading'])
    expect(renderMarkdown('## Title')[0]?.segments[0]?.bold).toBe(true)
    expect(texts('> quoted')).toEqual(['│ quoted'])
    expect(tones('> quoted')).toEqual(['quote'])
  })

  it('replaces a list marker with one glyph and keeps the indent', () => {
    expect(texts('- item\n  - nested\n1. first')).toEqual(['• item', '  • nested', '1. first'])
    expect(tones('- item')).toEqual(['bullet'])
  })

  it('styles the text of a list item but not its marker', () => {
    expect(renderMarkdown('- run `flush()`')[0]?.segments).toEqual([
      { text: '• ', tone: 'bullet' },
      { text: 'run ' },
      { text: 'flush()', tone: 'code' },
    ])
  })

  it('draws a thematic break as a rule', () => {
    expect(texts('---')).toEqual(['─'.repeat(24)])
    expect(renderMarkdown('---', ASCII_GLYPHS)[0]?.text).toBe('-'.repeat(24))
  })

  it('falls back to ASCII where the terminal cannot place box glyphs', () => {
    expect(renderMarkdown('- item\n> quoted', ASCII_GLYPHS).map(row => row.text))
      .toEqual(['- item', '| quoted'])
  })
})

describe('tables', () => {
  const source = [
    '| 工具 | 用途 |',
    '|------|------|',
    '| **read** | 读取文本文件内容 |',
    '| write | 创建新文件 |',
  ].join('\n')

  it('aligns columns by display width, so CJK cells line up', () => {
    const rows = renderMarkdown(source)
    expect(rows).toHaveLength(4)
    expect(rows[0]?.text).toBe('工具  │ 用途')
    expect(rows[2]?.text).toBe('read  │ 读取文本文件内容')
    expect(rows[3]?.text).toBe('write │ 创建新文件')
    // The separator lands on the same terminal column in every row, the rule
    // included — which is the whole point: `工具` is two characters and four
    // cells wide, `read` is four of each.
    const columnOf = (text: string): number =>
      displayWidth(text.slice(0, Math.max(text.indexOf('│'), text.indexOf('┼'))))
    expect(new Set(rows.map(row => columnOf(row.text))).size).toBe(1)
  })

  it('turns the separator row into the rule under the header', () => {
    const rule = renderMarkdown(source)[1]?.text ?? ''
    expect(rule).toMatch(/^─+┼─+$/)
    expect(rule).not.toContain('-')
  })

  it('keeps the header bold and the cell markup styled', () => {
    const rows = renderMarkdown(source)
    // Padding and the separator are their own runs, so only the cells are bold.
    for (const cell of ['工具', '用途']) {
      expect(rows[0]?.segments.some(s => s.text === cell && s.bold === true)).toBe(true)
    }
    expect(rows[2]?.segments.some(s => s.text === 'read' && s.bold === true)).toBe(true)
  })

  it('honours the alignment colons', () => {
    const rows = renderMarkdown([
      '| a | b |', '|---:|:--:|', '| 1 | 2 |',
    ].join('\n'))
    // Right-aligned first column, centred second.
    expect(rows[2]?.text).toBe('1 │ 2')
    expect(rows[0]?.text).toBe('a │ b')
  })

  it('leaves a table alone until its separator row arrives', () => {
    // Mid-stream the first row is not yet a table, and guessing would make it
    // jump the moment the second line lands.
    const partial = renderMarkdown('| 工具 | 用途 |')
    expect(partial[0]?.text).toBe('| 工具 | 用途 |')
  })

  it('leaves a table too wide to lay out as the model wrote it', () => {
    const wide = ['| a | b |', '|---|---|', `| ${'x'.repeat(500)} | b |`].join('\n')
    expect(renderMarkdown(wide)[2]?.text).toContain('|')
  })

  it('renders a ragged row without dropping or inventing a line', () => {
    const ragged = ['| a | b |', '|---|---|', '| 1 |', '| 1 | 2 | 3 |'].join('\n')
    expect(renderMarkdown(ragged)).toHaveLength(4)
  })
})

describe('cost guards', () => {
  it('detects text with nothing to render', () => {
    expect(isPlainText('just some ordinary prose, nothing special')).toBe(true)
    expect(isPlainText('some `code`')).toBe(false)
    expect(isPlainText('- a list')).toBe(false)
    expect(isPlainText('| a | b |')).toBe(false)
  })

  it('passes plain prose straight through, one segment per line', () => {
    const rendered = renderMarkdown('first line\nsecond line')
    expect(rendered).toEqual([
      { text: 'first line', segments: [{ text: 'first line' }] },
      { text: 'second line', segments: [{ text: 'second line' }] },
    ])
  })

  it('gives up on a message too long to be worth scanning', () => {
    const huge = `**bold**\n`.repeat(4_000)
    const rendered = renderMarkdown(huge)
    // Untouched: every line is one plain segment carrying its source.
    expect(rendered[0]).toEqual({ text: '**bold**', segments: [{ text: '**bold**' }] })
  })
})

describe('row invariants', () => {
  it('emits one line per source line whose segments sum to its text', () => {
    // These are what `transcript-view.ts` and `wrapSegments` rely on: the line
    // count keeps the header and detail rows aligned, and the segment sum keeps
    // a wrapped row's styling in step with its text.
    // A code span holding a single space is what first broke the old form of
    // this: the delimiters were consumed and nothing was left to line up.
    expect(renderMarkdown('` `')[0]).toEqual({ text: ' ', segments: [{ text: ' ', tone: 'code' }] })
    fc.assert(fc.property(fc.string({ maxLength: 300 }), (source) => {
      const rendered = renderMarkdown(source)
      expect(rendered).toHaveLength(source.split('\n').length)
      for (const row of rendered) expect(segmentText(row.segments)).toBe(row.text)
    }), { numRuns: 2_000 })
  })

  it('never leaves a rendered row wider than its source', () => {
    // Rendering only ever consumes markup, except for a table's padding, which
    // is bounded by the source row it pads.
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (source) => {
      for (const [index, row] of renderMarkdown(source).entries()) {
        const line = source.split('\n')[index] ?? ''
        if (!line.includes('|') && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          expect(displayWidth(row.text)).toBeLessThanOrEqual(displayWidth(line) + 2)
        }
      }
    }), { numRuns: 500 })
  })
})
