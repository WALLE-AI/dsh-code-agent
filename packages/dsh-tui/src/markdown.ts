/**
 * Line-oriented markdown rendering for streamed assistant text.
 *
 * This is deliberately not a parser. Assistant text arrives a token at a time
 * and is re-rendered on every delta, so the cost has to be linear in the text
 * and independent of how much of a construct has arrived: a line is rendered
 * from what it looks like right now, and an unterminated fence or `**` simply
 * stays plain until it closes. Block-level state is threaded through the line
 * loop; only fenced code and tables need any.
 *
 * The markup is consumed rather than shown: `**read**` is painted bold and the
 * asterisks are gone. Two invariants make that safe.
 *
 * - One output line per source line. `transcript-view.ts` takes the first line
 *   as the entry header and maps the rest onto detail rows by index, and the
 *   fold count is the number of detail rows — a line the renderer added or
 *   dropped would shift both. A table's separator row therefore becomes a rule,
 *   not nothing.
 * - Within a line, the segments still sum to its `text`. That is what
 *   `wrapSegments` walks when a row is too wide for the terminal.
 *
 * Two guards keep a pathological message from dominating a frame: a plain-text
 * fast path that skips the scan entirely, and a size ceiling above which the
 * text is passed through untouched.
 */

import { UNICODE_GLYPHS, type GlyphSet } from './glyphs.ts'
import type { RowTone, StyledSegment } from './styling.ts'
import { displayWidth } from './terminal-text.ts'

/** Above this, rendering is skipped: no message this long is worth the scan. */
const MAX_SOURCE_LENGTH = 20_000
/** Only this much of the text is probed for the fast path. */
const PROBE_LENGTH = 500
const SYNTAX_MARKERS = /[`*_#>~|]|^\s*[-+]\s|^\s*-{3,}\s*$|^\s*\d+\.\s/m

/** A table wider or taller than this is left as the model wrote it. */
const MAX_TABLE_WIDTH = 400
const MAX_TABLE_ROWS = 200
/** Width of a thematic break, which has no terminal width to measure against. */
const RULE_WIDTH = 24
/** Nesting depth for inline runs: enough for `**bold `code`**`, no more. */
const MAX_INLINE_DEPTH = 2

export interface MarkdownLine {
  /** What to show, and what the row is wrapped by. */
  readonly text: string
  /** Styled runs; concatenating their text yields `text` exactly. */
  readonly segments: readonly StyledSegment[]
}

/** True when the text contains nothing this renderer would touch. */
export function isPlainText(source: string): boolean {
  return !SYNTAX_MARKERS.test(source.slice(0, PROBE_LENGTH))
}

function line(segments: readonly StyledSegment[]): MarkdownLine {
  const kept = segments.filter(segment => segment.text !== '')
  return {
    text: kept.map(segment => segment.text).join(''),
    segments: kept.length === 0 ? [{ text: '' }] : kept,
  }
}

/** Apply a style to every run of an already-styled span. */
function restyle(
  segments: readonly StyledSegment[],
  style: Partial<StyledSegment>,
): readonly StyledSegment[] {
  return segments.map(segment => ({ ...segment, ...style }))
}

/** Give runs a tone unless they already carry one of their own. */
function toned(segments: readonly StyledSegment[], tone: RowTone): readonly StyledSegment[] {
  return segments.map(segment => (segment.tone === undefined ? { ...segment, tone } : segment))
}

/** One inline rule: what it matches, and the runs it turns the match into. */
interface InlineRule {
  readonly pattern: RegExp
  readonly build: (match: RegExpExecArray, depth: number) => readonly StyledSegment[]
}

/**
 * Inline rules, in precedence order.
 *
 * Every pattern requires its closing delimiter on the same line: mid-stream, a
 * lone `` ` `` is far more likely to be a construct that has not finished
 * arriving than an error, and half-styling it would make the row twitch as the
 * rest lands. Code comes first so `` `**not bold**` `` stays literal.
 */
const INLINE_RULES: readonly InlineRule[] = [
  {
    pattern: /^`([^`]+)`/,
    build: match => [{ text: match[1] ?? '', tone: 'code' }],
  },
  {
    pattern: /^\*\*(?!\s)([\s\S]+?)\*\*/,
    build: (match, depth) => restyle(inlineRuns(match[1] ?? '', depth + 1), { bold: true }),
  },
  {
    pattern: /^__(?!\s)([\s\S]+?)__/,
    build: (match, depth) => restyle(inlineRuns(match[1] ?? '', depth + 1), { bold: true }),
  },
  {
    pattern: /^~~(?!\s)([\s\S]+?)~~/,
    build: (match, depth) => restyle(
      inlineRuns(match[1] ?? '', depth + 1), { strikethrough: true },
    ),
  },
  // Single-delimiter emphasis, after the doubled forms so `**` never matches as
  // two italics. `_` is only emphasis between non-word characters: `read_image`
  // and `str_replace_editor` are the common case, and they are not italic.
  {
    pattern: /^\*(?![\s*])([^*\n]+)\*(?!\*)/,
    build: (match, depth) => restyle(inlineRuns(match[1] ?? '', depth + 1), { italic: true }),
  },
  {
    pattern: /^_(?![\s_])([^_\n]+)_(?![\w_])/,
    build: (match, depth) => restyle(inlineRuns(match[1] ?? '', depth + 1), { italic: true }),
  },
  // A link shows its label and then its target, dimmed: the target is the part
  // a terminal cannot make clickable everywhere, and hiding it would lose the
  // only copyable form of it.
  {
    pattern: /^\[([^\]\n]*)\]\((\S+?)\)/,
    build: (match, depth) => [
      ...inlineRuns(match[1] ?? '', depth + 1),
      { text: ` (${match[2] ?? ''})`, tone: 'quote' as const },
    ],
  },
]

/** Whether `_` at this position can open emphasis, rather than sit inside a word. */
function opensUnderscore(text: string, index: number): boolean {
  const before = text[index - 1]
  return before === undefined || !/[\w]/.test(before)
}

function inlineRuns(source: string, depth = 0): readonly StyledSegment[] {
  const segments: StyledSegment[] = []
  let plain = ''
  let index = 0
  const flush = (): void => {
    if (plain !== '') segments.push({ text: plain })
    plain = ''
  }
  while (index < source.length) {
    const rest = source.slice(index)
    let matched = false
    if (depth < MAX_INLINE_DEPTH) {
      for (const rule of INLINE_RULES) {
        if (rest.startsWith('_') && !opensUnderscore(source, index)) break
        const match = rule.pattern.exec(rest)
        if (match === null) continue
        flush()
        segments.push(...rule.build(match, depth))
        index += match[0].length
        matched = true
        break
      }
    }
    if (matched) continue
    plain += source[index] ?? ''
    index++
  }
  flush()
  return segments.length === 0 ? [{ text: '' }] : segments
}

/**
 * Render the inline runs of one line, consuming the delimiters.
 *
 * Unmatched delimiters are left as literal text.
 */
export function styleInline(source: string): readonly StyledSegment[] {
  return inlineRuns(source)
}

function repeat(unit: string, cells: number): string {
  return unit.repeat(Math.max(0, cells))
}

type Align = 'left' | 'right' | 'center'

/**
 * Split the padding a cell needs into a left and a right run.
 *
 * The width is a *display* width, not a length: the tables the model writes are
 * mostly Chinese, and a CJK character occupies two terminal columns.
 */
function padding(text: string, width: number, align: Align): { left: string; right: string } {
  const slack = Math.max(0, width - displayWidth(text))
  const left = align === 'right' ? slack : align === 'center' ? Math.floor(slack / 2) : 0
  return { left: ' '.repeat(left), right: ' '.repeat(slack - left) }
}

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?[\s:|-]*-[\s:|-]*$/

/** Split a table row into cells, dropping the leading and trailing pipes. */
function tableCells(row: string): readonly string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(cell => cell.trim())
}

function alignOf(spec: string): Align {
  const cell = spec.trim()
  if (cell.startsWith(':') && cell.endsWith(':')) return 'center'
  if (cell.endsWith(':')) return 'right'
  return 'left'
}

/**
 * Render a pipe table as aligned columns.
 *
 * Column widths come from `displayWidth`, not `length`: the tables the model
 * writes are mostly Chinese, and a CJK cell occupies two terminal columns per
 * character. The terminal width is not known here — entries are built once and
 * wrapped per width later — so the table is laid out to its content and a table
 * too wide for the window falls back to the ordinary wrap.
 *
 * @returns one line per source row, or `undefined` when the block is not worth
 *   laying out, in which case the caller renders the rows as ordinary text.
 */
function renderTable(rows: readonly string[], glyphs: GlyphSet): readonly MarkdownLine[] | undefined {
  if (rows.length > MAX_TABLE_ROWS) return undefined
  const cells = rows.map(row => tableCells(row))
  const aligns = (cells[1] ?? []).map(alignOf)
  const columns = Math.max(...cells.map(row => row.length))
  // Every cell is styled first: the width that matters is the rendered one,
  // after `**` and backticks are gone.
  const styled = cells.map((row, index) => index === 1
    ? []
    : row.map(cell => {
      const runs = inlineRuns(cell)
      return index === 0 ? restyle(runs, { bold: true }) : runs
    }))
  const widths: number[] = []
  for (let column = 0; column < columns; column++) {
    let width = 0
    for (const [index, row] of styled.entries()) {
      if (index === 1) continue
      const runs = row[column]
      if (runs !== undefined) width = Math.max(width, displayWidth(segmentsText(runs)))
    }
    widths[column] = width
  }
  const total = widths.reduce((sum, width) => sum + width, 0) + (columns - 1) * 3
  if (total > MAX_TABLE_WIDTH) return undefined
  const vertical = glyphs.tableColumn
  const horizontal = glyphs.tableRow
  return rows.map((_, index) => {
    if (index === 1) {
      // The separator keeps its row so the line count matches the source, and
      // becomes the rule under the header rather than a row of dashes. The
      // joint is three cells wide, exactly like the ` │ ` it sits under.
      const rule = widths
        .map(width => repeat(horizontal, width))
        .join(`${horizontal}${glyphs.tableCross}${horizontal}`)
      return line([{ text: rule, tone: 'quote', dim: true }])
    }
    const row = styled[index] ?? []
    const segments: StyledSegment[] = []
    for (let column = 0; column < columns; column++) {
      const runs = row[column] ?? [{ text: '' }]
      const last = column === columns - 1
      const pad = padding(segmentsText(runs), widths[column] ?? 0, aligns[column] ?? 'left')
      // The padding is emitted around the styled runs rather than inside them,
      // so each run stays exactly what the cell said.
      if (pad.left !== '') segments.push({ text: pad.left })
      segments.push(...runs)
      // A trailing pad on the last column would be invisible whitespace at the
      // end of every row.
      if (!last) {
        if (pad.right !== '') segments.push({ text: pad.right })
        segments.push({ text: ` ${vertical} `, tone: 'quote', dim: true })
      }
    }
    return line(segments)
  })
}

function segmentsText(segments: readonly StyledSegment[]): string {
  return segments.map(segment => segment.text).join('')
}

/** Where a table block starts and how many rows it spans. */
function tableAt(lines: readonly string[], start: number): number {
  if (!TABLE_ROW.test(lines[start] ?? '')) return 0
  const rule = lines[start + 1]
  // Without the separator the block is not a table yet — mid-stream that is the
  // ordinary case, and guessing would make the first row jump when it arrives.
  if (rule === undefined || !TABLE_ROW.test(rule) || !TABLE_RULE.test(rule)) return 0
  let end = start + 2
  while (end < lines.length && TABLE_ROW.test(lines[end] ?? '')) end++
  return end - start
}

function renderBlockLine(source: string, glyphs: GlyphSet): MarkdownLine {
  const heading = /^(#{1,6})\s+(.*)$/.exec(source)
  if (heading?.[2] !== undefined) {
    // The hashes go; the weight and the colour say the same thing.
    return line(toned(restyle(inlineRuns(heading[2]), { bold: true }), 'heading'))
  }
  const quote = /^(\s*)>\s?(.*)$/.exec(source)
  if (quote?.[2] !== undefined) {
    return line([
      { text: `${quote[1] ?? ''}${glyphs.quoteBar} `, tone: 'quote' },
      ...toned(inlineRuns(quote[2]), 'quote'),
    ])
  }
  // A thematic break has no terminal width to measure against, so it takes a
  // fixed one rather than guessing at the window.
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(source)) {
    return line([{ text: repeat(glyphs.tableRow, RULE_WIDTH), tone: 'quote', dim: true }])
  }
  const bullet = /^(\s*)([-+*])\s+(.*)$/.exec(source)
  if (bullet?.[3] !== undefined) {
    return line([
      { text: `${bullet[1] ?? ''}${glyphs.listBullet} `, tone: 'bullet' },
      ...inlineRuns(bullet[3]),
    ])
  }
  const ordered = /^(\s*\d+\.\s)(.*)$/.exec(source)
  if (ordered?.[1] !== undefined && ordered[2] !== undefined) {
    return line([{ text: ordered[1], tone: 'bullet' }, ...inlineRuns(ordered[2])])
  }
  return line(inlineRuns(source))
}

/**
 * Render a block of assistant text, one output line per input line.
 *
 * @returns one entry per line, in order; each entry's segments concatenate to
 *   its own `text`.
 */
export function renderMarkdown(
  source: string,
  glyphs: GlyphSet = UNICODE_GLYPHS,
): readonly MarkdownLine[] {
  const lines = source.split('\n')
  if (source.length > MAX_SOURCE_LENGTH || isPlainText(source)) {
    return lines.map(text => ({ text, segments: [{ text }] }))
  }
  const out: MarkdownLine[] = []
  let inFence = false
  let index = 0
  while (index < lines.length) {
    const source_ = lines[index] ?? ''
    const fence = /^\s*```(.*)$/.exec(source_)
    if (fence !== null) {
      const info = (fence[1] ?? '').trim()
      inFence = !inFence
      // The fence itself becomes a rule carrying the language, so the block is
      // still marked off without three backticks on screen.
      out.push(line([{
        text: info === '' ? repeat(glyphs.tableRow, 3) : `${repeat(glyphs.tableRow, 3)} ${info}`,
        tone: 'code',
        dim: true,
      }]))
      index++
      continue
    }
    if (inFence) {
      // Code is shown as written: inside a fence there is no markup to consume.
      out.push({ text: source_, segments: [{ text: source_, tone: 'code' }] })
      index++
      continue
    }
    const span = tableAt(lines, index)
    if (span > 0) {
      const rows = lines.slice(index, index + span)
      const table = renderTable(rows, glyphs)
      if (table !== undefined) {
        out.push(...table)
        index += span
        continue
      }
    }
    out.push(renderBlockLine(source_, glyphs))
    index++
  }
  return out
}
