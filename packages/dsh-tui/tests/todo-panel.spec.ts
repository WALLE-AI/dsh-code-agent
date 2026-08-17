import { describe, expect, it } from 'vitest'
import type { ActivitySummary } from '../src/activity.ts'
import {
  ASCII_TODO_GLYPHS, buildTodoPanel, todoPanelRows,
} from '../src/todo-panel.ts'
import { displayWidth } from '../src/terminal-text.ts'

const IDLE: ActivitySummary = { planActive: false }

describe('todo panel', () => {
  it('stays out of the way when the projection has nothing to show', () => {
    expect(buildTodoPanel(IDLE, 80, 4)).toEqual([])
    expect(todoPanelRows(IDLE)).toBe(0)
  })

  it('shows the goal and the item in progress', () => {
    const rows = buildTodoPanel({
      planActive: false,
      goal: 'fix the flush race',
      todos: { total: 5, done: 2, active: 'reproduce the race' },
    }, 80, 4)
    expect(rows.map(row => row.text)).toEqual([
      '◆ fix the flush race',
      '└─ ● reproduce the race  (2/5)',
    ])
    expect(rows[1]?.active).toBe(true)
  })

  it('collapses to a receipt once every item is complete', () => {
    const rows = buildTodoPanel({
      planActive: false,
      goal: 'fix the flush race',
      todos: { total: 5, done: 5 },
    }, 80, 4)
    expect(rows[1]?.text).toBe('└─ ✓ 5/5 done')
    expect(rows[1]?.active).toBe(false)
  })

  it('leads with the goal glyph when there is no goal line above', () => {
    const rows = buildTodoPanel({
      planActive: false,
      todos: { total: 3, done: 1, active: 'write the test' },
    }, 80, 4)
    expect(rows.map(row => row.text)).toEqual(['◆ ● write the test  (1/3)'])
  })

  it('falls back to ASCII where wide glyphs cannot be drawn', () => {
    const rows = buildTodoPanel({
      planActive: false,
      goal: 'ship it',
      todos: { total: 2, done: 2 },
    }, 80, 4, ASCII_TODO_GLYPHS)
    expect(rows.map(row => row.text)).toEqual(['* ship it', '`- x 2/2 done'])
  })

  it('honours the row and column budget it was given', () => {
    const activity: ActivitySummary = {
      planActive: false,
      goal: 'a goal long enough to need cutting on a narrow terminal',
      todos: { total: 2, done: 0, active: 'the first item' },
    }
    expect(todoPanelRows(activity)).toBe(2)
    expect(buildTodoPanel(activity, 80, 1)).toHaveLength(1)
    expect(buildTodoPanel(activity, 0, 4)).toEqual([])
    for (const row of buildTodoPanel(activity, 20, 4)) {
      expect(displayWidth(row.text)).toBeLessThanOrEqual(20)
    }
  })
})
