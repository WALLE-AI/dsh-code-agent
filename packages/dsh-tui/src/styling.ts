/**
 * Row and segment styling vocabulary.
 *
 * Tone is a *semantic* name, never a colour: the palette in `theme.ts` maps it
 * to whatever the terminal can actually show, down to nothing at all under
 * `NO_COLOR`. Keeping the vocabulary here lets the card builders and the
 * transcript view share it without importing each other.
 */

/** The tone of a whole transcript entry. */
export type TranscriptTone = 'user' | 'assistant' | 'reasoning' | 'system' | 'tool' | 'error'

/**
 * The tone of a single row or run within one. A diff's added and removed lines
 * are the reason this exists: they belong to a `tool` entry but must not share
 * its colour.
 */
export type RowTone =
  | TranscriptTone
  | 'diff-add' | 'diff-remove' | 'diff-hunk'
  | 'code' | 'heading' | 'quote' | 'bullet' | 'badge'

/** One body row of a tool card, with the tone it should be painted in. */
export interface DetailLine {
  readonly text: string
  readonly tone?: RowTone
  /** Styled runs within the row; `text` stays the exact concatenation. */
  readonly segments?: readonly StyledSegment[]
}

/** A styled run within a row. Concatenating `text` yields the plain row. */
export interface StyledSegment {
  readonly text: string
  readonly tone?: RowTone
  readonly bold?: boolean
  readonly dim?: boolean
}

/** Wrap plain rows that carry no tone of their own. */
export function plainLines(rows: readonly string[]): readonly DetailLine[] {
  return rows.map(text => ({ text }))
}

/** The plain text of a styled row, for tests, search and no-colour fallback. */
export function segmentText(segments: readonly StyledSegment[]): string {
  return segments.map(segment => segment.text).join('')
}

/**
 * Redistribute styled runs across already-wrapped rows.
 *
 * The rows are produced by the text wrapper, so this only has to walk the
 * segments in step with them: whitespace the wrapper dropped at a break is
 * skipped, and a run that straddles a break is split. Keeping the wrap decision
 * in one place is what stops the styled and plain forms from disagreeing.
 */
export function wrapSegments(
  segments: readonly StyledSegment[],
  rows: readonly string[],
): readonly (readonly StyledSegment[])[] {
  const out: StyledSegment[][] = []
  // Walk the source as one string, tracking how far each row consumed.
  const source = segmentText(segments)
  let at = 0
  let segmentIndex = 0
  let offset = 0
  for (const row of rows) {
    // Skip whatever the wrapper dropped between rows (only ever whitespace).
    while (at < source.length && source.slice(at, at + row.length) !== row
      && /\s/.test(source[at] ?? '')) {
      at++
      offset++
      while (segmentIndex < segments.length
        && offset >= (segments[segmentIndex]?.text.length ?? 0)) {
        offset -= segments[segmentIndex]?.text.length ?? 0
        segmentIndex++
      }
    }
    const current: StyledSegment[] = []
    let remaining = row.length
    while (remaining > 0 && segmentIndex < segments.length) {
      const segment = segments[segmentIndex]
      if (segment === undefined) break
      const available = segment.text.length - offset
      const take = Math.min(available, remaining)
      current.push({ ...segment, text: segment.text.slice(offset, offset + take) })
      offset += take
      remaining -= take
      if (offset >= segment.text.length) {
        segmentIndex++
        offset = 0
      }
    }
    at += row.length
    out.push(current.length === 0 ? [{ text: row }] : current)
  }
  return out
}
