/**
 * Goal and todo panel.
 *
 * The projection already carries the goal and the todo counts; until now
 * nothing rendered them. The panel is deliberately self-effacing: it collapses
 * to a single line once the work is done and disappears entirely when there is
 * nothing to say, because a permanent panel costs transcript rows on every
 * frame.
 */

import type { ActivitySummary } from './activity.ts'
import { truncateToWidth } from './terminal-text.ts'

export interface TodoPanelRow {
  readonly text: string
  /** The row is the active item, so the view can highlight it. */
  readonly active: boolean
}

export interface TodoPanelGlyphs {
  readonly goal: string
  readonly active: string
  readonly done: string
  readonly branch: string
  readonly last: string
}

export const UNICODE_TODO_GLYPHS: TodoPanelGlyphs = Object.freeze({
  goal: '◆', active: '●', done: '✓', branch: '├─', last: '└─',
})

export const ASCII_TODO_GLYPHS: TodoPanelGlyphs = Object.freeze({
  goal: '*', active: 'o', done: 'x', branch: '|-', last: '`-',
})

/**
 * Build the panel rows.
 *
 * @param maxRows - row budget the layout granted; 0 hides the panel.
 */
export function buildTodoPanel(
  activity: ActivitySummary,
  columns: number,
  maxRows: number,
  glyphs: TodoPanelGlyphs = UNICODE_TODO_GLYPHS,
): readonly TodoPanelRow[] {
  if (maxRows <= 0 || columns <= 0) return []
  const { goal, todos } = activity
  if (goal === undefined && todos === undefined) return []

  const rows: TodoPanelRow[] = []
  if (goal !== undefined) rows.push({ text: `${glyphs.goal} ${goal}`, active: false })
  if (todos !== undefined) {
    const complete = todos.done >= todos.total
    // Finished work is a one-line receipt, not a list.
    if (complete || todos.active === undefined) {
      rows.push({
        text: `${rows.length === 0 ? glyphs.goal : glyphs.last} ${complete ? glyphs.done : glyphs.active}`
          + ` ${String(todos.done)}/${String(todos.total)} done`,
        active: false,
      })
    } else {
      rows.push({
        text: `${rows.length === 0 ? glyphs.goal : glyphs.last} ${glyphs.active} ${todos.active}`
          + `  (${String(todos.done)}/${String(todos.total)})`,
        active: true,
      })
    }
  }
  return rows.slice(0, maxRows).map(row => ({ ...row, text: truncateToWidth(row.text, columns) }))
}

/** Rows the panel wants, so the layout can budget for it before rendering. */
export function todoPanelRows(activity: ActivitySummary): number {
  return (activity.goal === undefined ? 0 : 1) + (activity.todos === undefined ? 0 : 1)
}
