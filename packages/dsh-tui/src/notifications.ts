/**
 * The notice queue.
 *
 * The frame has exactly one row for a notice, and until now that row was a
 * single string: whatever was said last won, and nothing ever expired. Two real
 * cases made that visibly wrong — a terminal-capability warning raised at
 * startup was overwritten by the `resumed session …` line one statement later,
 * and a `/mouse` toggle stayed on screen for the rest of the session.
 *
 * So the row is fed by a queue instead. The rules are the smallest set that
 * fixes both:
 *
 * - **Priority, not recency.** A higher-priority notice is shown first; equal
 *   priorities keep their arrival order, so a burst still reads as a sequence.
 * - **Everything expires.** A notice holds the row for its own timeout and then
 *   yields it, so an idle frame settles back to nothing.
 * - **A key is an identity.** Pushing the same key again replaces — or, when the
 *   notice says how, {@link Notice.fold}s into — the one already there, so a
 *   repeated event counts up rather than queueing up.
 * - **A notice may retract others.** {@link Notice.invalidates} drops the keys
 *   an event has made untrue, wherever they are.
 *
 * Time is a parameter, never read. Nothing here schedules anything: the caller
 * advances the queue with {@link tickNotices}, which is what lets an idle
 * session hold no timer at all.
 */

import type { RowTone } from './styling.ts'

/**
 * How badly the notice wants the row.
 *
 * `immediate` is not "very high" — it means *this answers the action in
 * progress*. It takes the row now, because a reply that waits behind an ambient
 * warning is not a reply. What it displaces is not lost: it goes back in line at
 * its own priority and returns once the answer has been read.
 *
 * Everything else is ambient, and waits its turn. That ordering is the one that
 * matters: a capability warning raised at startup must not outrank the answer to
 * a key pressed thirty seconds later.
 */
export type NoticePriority = 'low' | 'medium' | 'high' | 'immediate'

const RANK: Record<NoticePriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  immediate: 3,
}

/** How long a notice holds the row when it does not say. */
export const DEFAULT_NOTICE_MS = 8_000

export interface Notice {
  /** Identity. Pushing the same key again replaces or folds, never duplicates. */
  readonly key: string
  readonly text: string
  readonly tone?: RowTone
  readonly priority: NoticePriority
  readonly timeoutMs?: number
  /** Keys this notice has made untrue, dropped wherever they are. */
  readonly invalidates?: readonly string[]
  /**
   * Merge an incoming notice of the same key into the one already held.
   * Called as `fold(held, incoming)`; the result should carry `fold` forward so
   * a third arrival merges too.
   */
  readonly fold?: (held: Notice, incoming: Notice) => Notice
}

export interface NoticeQueue {
  /** The notice holding the row, if any. */
  readonly current?: Notice
  /** When `current` yields the row, on the clock the pushes were stamped with. */
  readonly expiresAtMs?: number
  /** Waiting notices, highest priority first, arrival order within a priority. */
  readonly queue: readonly Notice[]
}

export const emptyNoticeQueue: NoticeQueue = Object.freeze({ queue: Object.freeze([]) })

/** Promote the head of the queue when the row is free. */
function promote(state: NoticeQueue, nowMs: number): NoticeQueue {
  if (state.current !== undefined || state.queue.length === 0) return state
  const [next, ...rest] = state.queue
  if (next === undefined) return state
  return {
    current: next,
    expiresAtMs: nowMs + (next.timeoutMs ?? DEFAULT_NOTICE_MS),
    queue: rest,
  }
}

/** Insert by priority, keeping arrival order within one priority. */
function insert(queue: readonly Notice[], notice: Notice): readonly Notice[] {
  const rank = RANK[notice.priority]
  const at = queue.findIndex(held => RANK[held.priority] < rank)
  if (at === -1) return [...queue, notice]
  return [...queue.slice(0, at), notice, ...queue.slice(at)]
}

function merged(held: Notice, incoming: Notice): Notice {
  // The held notice owns the merge rule: it is the one that knows what it has
  // been accumulating. An incoming notice with no counterpart just replaces.
  return held.fold === undefined ? incoming : held.fold(held, incoming)
}

/**
 * Add a notice.
 *
 * The row is claimed straight away when it is free, or when the arrival is
 * `immediate` — in which case whatever was showing goes back to the queue at
 * its own priority rather than being lost.
 */
export function pushNotice(state: NoticeQueue, notice: Notice, nowMs: number): NoticeQueue {
  const retracted = new Set(notice.invalidates ?? [])
  let current = state.current !== undefined && retracted.has(state.current.key)
    ? undefined
    : state.current
  let queue: readonly Notice[] = state.queue.filter(held => !retracted.has(held.key))

  // Same key: fold into whichever copy is holding it, and stay where it is.
  if (current?.key === notice.key) {
    const next = merged(current, notice)
    return {
      current: next,
      // Folding refreshes the timeout: the notice has just said something new.
      expiresAtMs: nowMs + (next.timeoutMs ?? DEFAULT_NOTICE_MS),
      queue,
    }
  }
  const at = queue.findIndex(held => held.key === notice.key)
  if (at !== -1) {
    const held = queue[at]
    const next = held === undefined ? notice : merged(held, notice)
    queue = [...queue.slice(0, at), ...queue.slice(at + 1)]
    queue = insert(queue, next)
    return promote({
      ...(current === undefined ? {} : { current }),
      ...(current === undefined || state.expiresAtMs === undefined
        ? {} : { expiresAtMs: state.expiresAtMs }),
      queue,
    }, nowMs)
  }

  if (notice.priority === 'immediate' && current !== undefined) {
    // What it displaced is not lost; it goes back in line at its own priority.
    queue = insert(queue, current)
    current = undefined
  }
  queue = insert(queue, notice)
  return promote({
    ...(current === undefined ? {} : { current }),
    ...(current === undefined || state.expiresAtMs === undefined
      ? {} : { expiresAtMs: state.expiresAtMs }),
    queue,
  }, nowMs)
}

/** Retire the showing notice once its time is up, and promote the next. */
export function tickNotices(state: NoticeQueue, nowMs: number): NoticeQueue {
  if (state.current === undefined) return promote(state, nowMs)
  if (state.expiresAtMs !== undefined && nowMs < state.expiresAtMs) return state
  return promote({ queue: state.queue }, nowMs)
}

/** Drop one notice by key, wherever it is. */
export function dropNotice(state: NoticeQueue, key: string, nowMs: number): NoticeQueue {
  const queue = state.queue.filter(held => held.key !== key)
  if (state.current?.key === key) return promote({ queue }, nowMs)
  return {
    ...(state.current === undefined ? {} : { current: state.current }),
    ...(state.expiresAtMs === undefined ? {} : { expiresAtMs: state.expiresAtMs }),
    queue,
  }
}

/** Clear the row and everything waiting for it. */
export function clearNotices(): NoticeQueue {
  return emptyNoticeQueue
}

/**
 * A plain string, as the ad-hoc notices still send. Medium priority, a key
 * derived from the text so the same message twice does not queue twice.
 */
export function textNotice(text: string, overrides: Partial<Notice> = {}): Notice {
  return { key: `text:${text}`, text, priority: 'medium', ...overrides }
}
