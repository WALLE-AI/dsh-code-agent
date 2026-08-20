/**
 * The line shown above the composer while the Agent is working.
 *
 * Its job is to make a long wait legible: something is turning, it has been
 * turning for this long, this much has come back — and, when it stops coming
 * back, that too. The verb is decorative but it is picked from the turn index
 * rather than at random, so a frame is reproducible from its inputs and the view
 * stays snapshot-testable.
 *
 * Every field is optional under width pressure. The line is assembled from the
 * most important part outward and stops when the next part will not fit, so a
 * forty-column terminal keeps the spinner and the verb rather than wrapping onto
 * a second row and breaking the layout budget.
 */

import { formatElapsed } from './spinner.ts'
import { displayWidth, truncateToWidth } from './terminal-text.ts'

/**
 * Token counts only appear once the wait is long enough to want them. Before
 * that they are noise on a line that is already changing every 80 ms.
 */
export const TOKENS_AFTER_MS = 30_000

/**
 * How long output may stop before the wait is called stalled.
 *
 * A run with a tool in flight is never stalled however quiet it is: the tool is
 * the work, and its own card is already saying so. This only fires when the
 * model itself has gone silent, which is the case a reader cannot otherwise
 * distinguish from progress.
 */
export const STALL_AFTER_MS = 10_000

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
  /**
   * What the Agent is doing right now, in the tool's own words — `Reading
   * src/app.tsx` rather than `Working…`. Taken from the running card's title,
   * so a tool this profile has never heard of still describes itself.
   */
  readonly activity?: string
  /** How long output has been absent; omitted when nothing is being awaited. */
  readonly silentMs?: number
  /** A tool is in flight, so silence is the tool working rather than a stall. */
  readonly toolRunning?: boolean
}

export interface WorkingLine {
  readonly text: string
  /**
   * The run has gone quiet for longer than {@link STALL_AFTER_MS}. The view
   * paints the row in a warning tone; the wait itself is unchanged.
   */
  readonly stalled: boolean
}

function compactTokens(value: number): string {
  return value < 1_000 ? String(value) : `${(value / 1_000).toFixed(1)}k`
}

/**
 * Render the working line, bounded to the terminal width.
 *
 * Fields are appended in falling order of worth and the first one that does not
 * fit ends the line. The spinner and the subject are what say the run is alive,
 * so they are what a narrow terminal keeps.
 */
export function buildWorkingLine(input: WorkingLineInput, columns: number): WorkingLine {
  const stalled = input.toolRunning !== true
    && input.silentMs !== undefined
    && input.silentMs >= STALL_AFTER_MS
  if (columns <= 0) return { text: '', stalled }

  // The activity is the better subject when there is one: `Reading src/app.tsx`
  // says more than any verb this profile could invent.
  const subject = input.activity ?? `${workingVerb(input.turn)}…`
  // The stall comes first because fields are dropped from the end: it is the
  // one field that changes what the reader should do about the wait, so it is
  // the one a narrow terminal must keep.
  const optional: string[] = stalled && input.silentMs !== undefined
    ? [`no output for ${formatElapsed(input.silentMs)}`, formatElapsed(input.elapsedMs)]
    : [formatElapsed(input.elapsedMs)]
  if (input.tokens !== undefined && input.elapsedMs >= TOKENS_AFTER_MS) {
    optional.push(`${compactTokens(input.tokens)} tokens`)
  }

  const head = `${input.frame} ${subject}`
  let text = head
  for (const part of optional) {
    const next = `${text} ${input.separator} ${part}`
    if (displayWidth(next) > columns) break
    text = next
  }
  return { text: truncateToWidth(text, columns), stalled }
}
