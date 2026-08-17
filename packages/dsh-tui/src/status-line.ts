/**
 * Status row model.
 *
 * The row is built as segments with an explicit drop order rather than wrapped
 * or truncated as one string: on a narrow terminal the fields that fall away
 * should be the ones you can reconstruct (the session title, the directory),
 * never the permission preset or the context pressure.
 */

import type { ActivityCounters, ActivitySummary } from './activity.ts'
import { displayWidth, truncateToWidth } from './terminal-text.ts'

export interface StatusSegment {
  readonly text: string
  /** Lower drops first when the row does not fit. */
  readonly priority: number
}

export interface ContextBar {
  readonly used: number
  readonly total: number
}

export interface StatusModel {
  /** Context pressure, when the projection reported a window to measure against. */
  readonly bar?: ContextBar
  readonly left: readonly StatusSegment[]
  readonly right: readonly StatusSegment[]
  readonly hint: string
}

export interface StatusContext {
  /** The model route the Harness resolved, once it has reported one. */
  readonly model?: string
  /** Git branch, when the workspace is a checkout. */
  readonly branch?: string
  /** Last segment of the working directory. */
  readonly directory?: string
  readonly running: boolean
  /** The transcript is scrolled away from the tail. */
  readonly paused: boolean
  readonly unread: number
}

/** Sub-cell ladder, so a bar narrower than the value still moves. */
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const

/**
 * Render a proportional bar `width` cells wide. The filled portion is rounded
 * down to a whole cell plus a partial cell, so a nearly-empty context never
 * reads as one full cell of pressure.
 */
export function renderContextBar(used: number, total: number, width: number): string {
  if (width <= 0 || total <= 0) return ''
  const ratio = Math.max(0, Math.min(1, used / total))
  const eighths = Math.round(ratio * width * 8)
  const full = Math.floor(eighths / 8)
  const partial = EIGHTHS[eighths % 8] ?? ''
  const filled = '█'.repeat(Math.min(width, full)) + (full < width ? partial : '')
  return filled + ' '.repeat(Math.max(0, width - displayWidth(filled)))
}

function compact(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * Fold the activity projection into the row model. Priorities are assigned here
 * so the drop order is one decision in one place.
 */
export function buildStatusModel(
  activity: ActivitySummary,
  counters: ActivityCounters,
  context: StatusContext,
): StatusModel {
  const left: StatusSegment[] = []
  // The model and the preset are what the run is: neither is ever dropped.
  if (context.model !== undefined) left.push({ text: context.model, priority: 0 })
  // Priority 0 is never dropped: it is what the run is allowed to do.
  if (activity.permission !== undefined) left.push({ text: activity.permission.current, priority: 0 })
  if (activity.planActive) left.push({ text: 'plan', priority: 0 })
  if (activity.context?.percent !== undefined) {
    left.push({ text: `ctx ${String(activity.context.percent)}%`, priority: 1 })
  }
  if (activity.todos !== undefined) {
    left.push({
      text: `todo ${String(activity.todos.done)}/${String(activity.todos.total)}`,
      priority: 2,
    })
  }
  left.push({ text: `tools ${String(counters.tools)}`, priority: 3 })
  if (counters.filesAdded > 0 || counters.filesRemoved > 0) {
    left.push({
      text: `files +${String(counters.filesAdded)} -${String(counters.filesRemoved)}`,
      priority: 3,
    })
  }
  if (counters.approvals > 0) left.push({ text: `approvals ${String(counters.approvals)}`, priority: 4 })
  if (activity.subagent !== undefined) {
    left.push({ text: `subagent ${activity.subagent}`, priority: 4 })
  }
  if (activity.tokens !== undefined) {
    left.push({
      text: `tok ${compact(activity.tokens.input)}→${compact(activity.tokens.output)}`,
      priority: 5,
    })
  }

  const right: StatusSegment[] = []
  if (context.branch !== undefined) right.push({ text: context.branch, priority: 1 })
  if (context.directory !== undefined) right.push({ text: context.directory, priority: 2 })
  // The title is the most reconstructible field, so it goes first.
  if (activity.title !== undefined) right.push({ text: activity.title, priority: 3 })

  return {
    ...(activity.context?.tokens === undefined || activity.context.window === undefined
      ? {}
      : { bar: { used: activity.context.tokens, total: activity.context.window } }),
    left,
    right,
    hint: context.paused
      ? context.unread === 0 ? 'paused' : `paused · ${String(context.unread)} unread`
      : context.running ? 'esc to interrupt' : 'ctrl+p commands',
  }
}

const SEPARATOR = ' · '

/**
 * Join segments into a row that fits `columns`, dropping whole segments from
 * the lowest priority up rather than cutting one mid-word.
 */
export function renderSegments(segments: readonly StatusSegment[], columns: number): string {
  if (columns <= 0) return ''
  let kept = [...segments]
  const join = (parts: readonly StatusSegment[]): string =>
    parts.map(part => part.text).join(SEPARATOR)
  // Stop at one: an oversized lone segment is cut below, not dropped, so the
  // row never goes blank when the terminal is narrower than a single field.
  while (kept.length > 1 && displayWidth(join(kept)) > columns) {
    const worst = kept.reduce((a, b) => (b.priority > a.priority ? b : a))
    const index = kept.lastIndexOf(worst)
    kept = [...kept.slice(0, index), ...kept.slice(index + 1)]
  }
  // Even a single segment can outgrow the row; cutting it is the last resort.
  return truncateToWidth(join(kept), columns)
}
