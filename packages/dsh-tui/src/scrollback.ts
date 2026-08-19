/**
 * Splitting the transcript between the terminal's scrollback and the live frame.
 *
 * The profile used to paint the whole transcript as one repainted viewport. That
 * put every row the session ever produced inside a region the terminal treats as
 * a single frame: rolling the wheel scrolled the shell's buffer, which held only
 * torn fragments of earlier repaints, and the conversation itself — banner
 * included — existed nowhere the terminal could scroll to. Wheel reporting was
 * turned on to compensate, which works only on terminals that forward it and
 * takes the wheel away from the ones that do.
 *
 * So rows leave the frame instead. An entry that can no longer change is written
 * once, through Ink's `<Static>`, into the terminal's real scrollback; only the
 * rows that can still change stay in the repainted frame. The wheel then belongs
 * to the terminal again and reaches the whole session on every terminal, with no
 * reporting mode and no cooperation from the app.
 *
 * What "can no longer change" means is the whole design:
 *
 * - **Only a prefix may flush.** Scrollback is append-only, so entries have to
 *   leave in order. One unsettled entry pins every entry after it, however
 *   settled those are.
 * - **A pending tool call is not settled**: its body streams and its status glyph
 *   is still moving.
 * - **The last entry is never settled**, whatever its status says. Assistant
 *   prose streams by growing the final entry, so the newest entry is always a
 *   candidate for more text.
 *
 * The cost is stated rather than worked around: a row in scrollback belongs to
 * the terminal. It cannot be re-wrapped when the window is resized, and the card
 * it came from can no longer be folded or unfolded. Both remain true for the
 * live region, which is where a card spends the time anyone is looking at it.
 */

import type { TranscriptEntry, TranscriptLine } from './transcript-view.ts'

/** The banner's rows, which the store prepends and which never change. */
const SPLASH_ENTRY_ID = 'splash'

export interface ScrollbackState {
  /** Every row handed to the terminal so far, oldest first. */
  readonly rows: readonly TranscriptLine[]
  /** Entry ids already written; a row of one of these is never emitted twice. */
  readonly emitted: ReadonlySet<string>
}

export const emptyScrollback: ScrollbackState = Object.freeze({
  rows: Object.freeze([]),
  emitted: Object.freeze(new Set<string>()),
})

/**
 * Ids of the entries that may leave the frame: the longest prefix of settled
 * ones, never including the last.
 */
export function settledEntryIds(entries: readonly TranscriptEntry[]): ReadonlySet<string> {
  const ids = new Set<string>()
  // `length - 1` rather than `length`: the newest entry is where streaming lands.
  for (let index = 0; index < entries.length - 1; index++) {
    const entry = entries[index]
    if (entry === undefined) break
    if (entry.nodeKind === 'tool' && entry.status === 'pending') break
    // A collapsed run can still absorb the call that follows it, once that call
    // settles as a kind the run collapses — and it keeps the same id, so the
    // rows already in the terminal would go on saying `3 reads` where the truth
    // had become four, in a scrollback the frame can no longer reach. A group
    // directly above a pending call has therefore not settled either, and
    // neither has anything after it: the flush is a prefix.
    const next = entries[index + 1]
    if (entry.collapsedFrom !== undefined
      && next?.nodeKind === 'tool' && next.status === 'pending') break
    ids.add(entry.id)
  }
  return ids
}

export interface ScrollbackSplit {
  /** The new state, to keep for the next frame. */
  readonly next: ScrollbackState
  /** Rows appended this time; empty when nothing settled. */
  readonly appended: readonly TranscriptLine[]
  /** Rows that stay in the repainted frame. */
  readonly live: readonly TranscriptLine[]
}

/**
 * Divide the store's rows into what leaves for the scrollback and what stays.
 *
 * @param lines - every row of the current projection, at the current width.
 * @param entries - the entries those rows came from, in the same order.
 * @param state - what has already been written to the terminal.
 *
 * Rows are matched to entries by id rather than by index because the two lists
 * are re-derived at different times: a resize re-wraps `lines` while `emitted`
 * still names entries written at the old width, and the store drops the oldest
 * nodes out of `entries` entirely once the window slides past them. An id is the
 * only thing that survives both.
 */
export function splitScrollback(
  lines: readonly TranscriptLine[],
  entries: readonly TranscriptEntry[],
  state: ScrollbackState,
): ScrollbackSplit {
  const settled = settledEntryIds(entries)
  const flushable = (line: TranscriptLine): boolean =>
    line.entryId === SPLASH_ENTRY_ID || settled.has(line.entryId)
  // Rows already in the terminal, skipped rather than re-emitted. They are a
  // prefix, so this stops at the first row that still has to be painted.
  let start = 0
  while (start < lines.length && state.emitted.has(lines[start]?.entryId ?? '')) start++
  let end = start
  while (end < lines.length && flushable(lines[end] as TranscriptLine)) end++
  const appended = lines.slice(start, end)
  if (appended.length === 0) {
    return { next: state, appended, live: lines.slice(end) }
  }
  const emitted = new Set(state.emitted)
  for (const line of appended) emitted.add(line.entryId)
  return {
    next: { rows: [...state.rows, ...appended], emitted },
    appended,
    live: lines.slice(end),
  }
}
