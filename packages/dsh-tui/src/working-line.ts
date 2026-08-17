/**
 * The line shown above the composer while the Agent is working.
 *
 * Its job is to make a long wait legible: something is turning, it has been
 * turning for this long, and this much has come back. The verb is decorative
 * but it is picked from the turn index rather than at random, so a frame is
 * reproducible from its inputs and the view stays snapshot-testable.
 */

import { formatElapsed } from './spinner.ts'
import { truncateToWidth } from './terminal-text.ts'

/**
 * Token counts only appear once the wait is long enough to want them. Before
 * that they are noise on a line that is already changing every 80 ms.
 */
export const TOKENS_AFTER_MS = 30_000

const VERBS = [
  'Working', 'Thinking', 'Digging', 'Reasoning', 'Puzzling', 'Considering',
  'Tracing', 'Weighing', 'Composing', 'Checking',
] as const

/** The verb for one turn. Stable within the turn, varied across turns. */
export function workingVerb(turn: number): string {
  const index = Math.abs(Math.trunc(turn)) % VERBS.length
  return VERBS[index] ?? VERBS[0]
}

export interface WorkingLineInput {
  /** Current spinner frame, or the static glyph when animation is off. */
  readonly frame: string
  readonly turn: number
  readonly elapsedMs: number
  /** Output tokens so far, when the projection has reported any. */
  readonly tokens?: number
  /** Separator glyph, so a degraded terminal stays ASCII. */
  readonly separator: string
}

function compactTokens(value: number): string {
  return value < 1_000 ? String(value) : `${(value / 1_000).toFixed(1)}k`
}

/** Render the working line, bounded to the terminal width. */
export function buildWorkingLine(input: WorkingLineInput, columns: number): string {
  if (columns <= 0) return ''
  const parts = [`${workingVerb(input.turn)}…`, formatElapsed(input.elapsedMs)]
  if (input.tokens !== undefined && input.elapsedMs >= TOKENS_AFTER_MS) {
    parts.push(`${compactTokens(input.tokens)} tokens`)
  }
  return truncateToWidth(
    `${input.frame} ${parts.join(` ${input.separator} `)}`,
    columns,
  )
}
