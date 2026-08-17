import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { buildOverlay, fitHint, overlayWindow, type OverlayRow } from '../src/overlay.ts'
import { displayWidth } from '../src/terminal-text.ts'

function rows(count: number, lines = 1): readonly OverlayRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `r${String(index)}`,
    text: `row-${String(index)}`,
    lines,
  }))
}

describe('overlay window', () => {
  it('keeps the focused row inside the window, wherever it is', () => {
    const list = rows(30)
    for (const focus of [0, 1, 7, 15, 28, 29]) {
      const window = overlayWindow(list, focus, 6)
      expect(focus, `focus ${String(focus)} fell outside`).toBeGreaterThanOrEqual(window.start)
      expect(focus).toBeLessThan(window.end)
    }
  })

  it('centres the focus when both sides have room', () => {
    const window = overlayWindow(rows(30), 15, 5)
    expect(window.start).toBe(13)
    expect(window.end).toBe(18)
  })

  it('pins against the end rather than leaving the window short', () => {
    expect(overlayWindow(rows(30), 29, 5)).toMatchObject({ start: 25, end: 30 })
    expect(overlayWindow(rows(30), 0, 5)).toMatchObject({ start: 0, end: 5 })
  })

  it('budgets by rows, not by entries', () => {
    // Two-line entries: a five-row budget fits two of them, not five.
    const window = overlayWindow(rows(30, 2), 10, 5)
    expect(window.end - window.start).toBe(2)
  })

  it('still shows the focused row when it alone exceeds the budget', () => {
    const window = overlayWindow(rows(10, 9), 4, 3)
    expect(window.start).toBe(4)
    expect(window.end).toBe(5)
  })

  it('reports what it hid', () => {
    const window = overlayWindow(rows(30), 15, 5)
    expect(window.before).toBe(13)
    expect(window.after).toBe(12)
  })

  it('handles an empty list and a zero budget', () => {
    expect(overlayWindow([], 0, 5)).toEqual({ start: 0, end: 0, before: 0, after: 0 })
    expect(overlayWindow(rows(5), 2, 0)).toEqual({ start: 0, end: 0, before: 0, after: 5 })
  })

  it('never drops the focus, for any list size, focus and budget', () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 60 }),
      fc.integer({ min: 0, max: 59 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 1, max: 3 }),
      (count, focusSeed, budget, lines) => {
        const list = rows(count, lines)
        const focus = focusSeed % count
        const window = overlayWindow(list, focus, budget)
        expect(focus).toBeGreaterThanOrEqual(window.start)
        expect(focus).toBeLessThan(window.end)
      },
    ))
  })
})

describe('overlay rendering', () => {
  it('marks the focused row and bounds every row to the width', () => {
    const view = buildOverlay(rows(10), 3, {
      title: 'Commands', hint: 'Enter to run', columns: 20, rowBudget: 3,
    })
    expect(view.rows.some(row => row.startsWith('> row-3'))).toBe(true)
    for (const row of view.rows) expect(displayWidth(row)).toBeLessThanOrEqual(20)
  })

  it('says how much is hidden on each side', () => {
    const view = buildOverlay(rows(30), 15, {
      title: 'Sessions', hint: '', columns: 40, rowBudget: 5,
    })
    expect(view.above).toBe('↑ 13 more')
    expect(view.below).toBe('↓ 12 more')
  })

  it('omits the scroll hints when the whole list fits', () => {
    const view = buildOverlay(rows(3), 0, {
      title: 'Commands', hint: '', columns: 40, rowBudget: 10,
    })
    expect(view.above).toBeUndefined()
    expect(view.below).toBeUndefined()
  })

  it('renders a description on its own row when the entry claims two', () => {
    const view = buildOverlay(
      [{ id: 'a', text: '/permission', description: 'Switch preset', lines: 2 }],
      0,
      { title: 'Commands', hint: '', columns: 40, rowBudget: 4 },
    )
    expect(view.rows).toEqual(['> /permission', '    Switch preset'])
  })

  it('says so when there is nothing to show', () => {
    const view = buildOverlay([], 0, {
      title: 'Sessions', hint: '', columns: 40, rowBudget: 5, emptyText: 'no resumable sessions',
    })
    expect(view.rows).toEqual(['no resumable sessions'])
  })
})

describe('hint fitting', () => {
  const variants = [
    '↑↓ select · Enter run · Esc close',
    '↑↓ · Enter · Esc',
    'Esc',
  ]

  it('takes the widest variant that fits', () => {
    expect(fitHint(variants, 40)).toBe(variants[0])
    expect(fitHint(variants, 20)).toBe(variants[1])
    expect(fitHint(variants, 5)).toBe(variants[2])
  })

  it('cuts the shortest variant rather than returning nothing', () => {
    const fitted = fitHint(variants, 2)
    expect(displayWidth(fitted)).toBeLessThanOrEqual(2)
  })
})
