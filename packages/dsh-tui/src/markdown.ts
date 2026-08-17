/**
 * Minimal, line-oriented markdown styling for streamed assistant text.
 *
 * This is deliberately not a parser. Assistant text arrives a token at a time
 * and is re-rendered on every delta, so the cost has to be linear in the text
 * and independent of how much of a construct has arrived: a line is styled from
 * what it looks like right now, and an unterminated fence or `**` simply stays
 * plain until it closes. Block-level state is threaded through the line loop —
 * only fenced code needs it.
 *
 * Two guards keep a pathological message from dominating a frame: a plain-text
 * fast path that skips the scan entirely, and a size ceiling above which the
 * text is passed through untouched.
 */

import type { DetailLine, StyledSegment } from './styling.ts'

/** Above this, styling is skipped: no message this long is worth the scan. */
const MAX_SOURCE_LENGTH = 20_000
/** Only this much of the text is probed for the fast path. */
const PROBE_LENGTH = 500
const SYNTAX_MARKERS = /[`*_#>]|^\s*[-+]\s|^\s*\d+\.\s/m

export interface MarkdownLine {
  readonly segments: readonly StyledSegment[]
}

/** True when the text contains nothing this renderer would style. */
export function isPlainText(source: string): boolean {
  return !SYNTAX_MARKERS.test(source.slice(0, PROBE_LENGTH))
}

/**
 * Style the inline runs of one line: `**bold**` and `` `code` ``.
 *
 * Delimiters stay in the text — see the note in the loop.
 *
 * Unmatched delimiters are left as literal text — mid-stream, a lone `` ` `` is
 * far more likely to be a fence that has not finished arriving than an error.
 */
export function styleInline(line: string): readonly StyledSegment[] {
  const segments: StyledSegment[] = []
  let plain = ''
  let index = 0
  const flush = (): void => {
    if (plain !== '') segments.push({ text: plain })
    plain = ''
  }
  while (index < line.length) {
    const rest = line.slice(index)
    // The delimiters are kept, not consumed: a styled row's text must stay
    // character-identical to its source, because the same string drives
    // wrapping, width and search. Tinting marks the run without hiding it.
    const code = /^`[^`]+`/.exec(rest)
    if (code !== null) {
      flush()
      segments.push({ text: code[0], tone: 'code' })
      index += code[0].length
      continue
    }
    const bold = /^\*\*[^*]+\*\*/.exec(rest)
    if (bold !== null) {
      flush()
      segments.push({ text: bold[0], bold: true })
      index += bold[0].length
      continue
    }
    plain += line[index] ?? ''
    index++
  }
  flush()
  return segments.length === 0 ? [{ text: '' }] : segments
}

/**
 * Style a block of assistant text, one output line per input line.
 *
 * @returns one entry per line, in order; the concatenated segment text of each
 *   equals its source line, so plain-text fallbacks and search stay exact.
 */
export function renderMarkdown(source: string): readonly MarkdownLine[] {
  const lines = source.split('\n')
  if (source.length > MAX_SOURCE_LENGTH || isPlainText(source)) {
    return lines.map(text => ({ segments: [{ text }] }))
  }
  const out: MarkdownLine[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push({ segments: [{ text: line, tone: 'code', dim: true }] })
      continue
    }
    if (inFence) {
      out.push({ segments: [{ text: line, tone: 'code' }] })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading?.[2] !== undefined) {
      // The hashes are kept: dropping them would change the row's width and
      // desynchronise the plain text used for wrapping and search.
      out.push({ segments: [{ text: line, tone: 'heading', bold: true }] })
      continue
    }
    const quote = /^\s*>\s/.test(line)
    if (quote) {
      out.push({ segments: [{ text: line, tone: 'quote' }] })
      continue
    }
    const bullet = /^(\s*(?:[-+*]|\d+\.)\s)(.*)$/.exec(line)
    if (bullet?.[1] !== undefined && bullet[2] !== undefined) {
      out.push({
        segments: [{ text: bullet[1], tone: 'bullet' }, ...styleInline(bullet[2])],
      })
      continue
    }
    out.push({ segments: styleInline(line) })
  }
  return out
}

/** Style assistant detail rows in place, leaving any other tone untouched. */
export function markdownDetail(rows: readonly DetailLine[]): readonly MarkdownLine[] {
  return renderMarkdown(rows.map(row => row.text).join('\n'))
}
