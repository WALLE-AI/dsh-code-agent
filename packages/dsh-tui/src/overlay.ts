/**
 * Overlay list model.
 *
 * Stock Ink has no absolute positioning, so an overlay here is a region that
 * takes rows from the same budget as everything else — the row budget *is* the
 * layout. What matters is which rows it spends them on: the window is computed
 * from a row budget rather than an item count, because a row can be two lines
 * tall and a naive "centre on the index" slice pushes the focused row off the
 * end of a long list.
 */

import { truncateToWidth } from './terminal-text.ts'

export interface OverlayRow {
  readonly id: string
  readonly text: string
  readonly description?: string
  /** Rows this entry occupies; 1 unless it carries a description line. */
  readonly lines: number
}

export interface OverlayWindow {
  readonly start: number
  readonly end: number
  /** Entries hidden above and below, for the scroll hint. */
  readonly before: number
  readonly after: number
}

/**
 * Choose the visible slice.
 *
 * The focused row is placed first and the window then grows alternately up and
 * down, taking whichever side is currently shorter. That keeps the focus near
 * the middle when it can, pins it against the end when it cannot, and — the
 * point of the exercise — never drops it.
 */
export function overlayWindow(
  rows: readonly OverlayRow[],
  selectedIndex: number,
  rowBudget: number,
): OverlayWindow {
  if (rows.length === 0 || rowBudget <= 0) {
    return { start: 0, end: 0, before: 0, after: rows.length }
  }
  const focus = Math.max(0, Math.min(selectedIndex, rows.length - 1))
  let start = focus
  let end = focus + 1
  let used = rows[focus]?.lines ?? 1
  // The focused row is shown even when it alone exceeds the budget: a clipped
  // row still tells you where you are, an empty pane does not.
  for (;;) {
    const canGrowUp = start > 0
    const canGrowDown = end < rows.length
    if (!canGrowUp && !canGrowDown) break
    // Prefer the shorter side so the focus drifts to the middle.
    const takeUp = canGrowUp && (!canGrowDown || focus - start <= end - focus - 1)
    const next = takeUp ? rows[start - 1] : rows[end]
    const cost = next?.lines ?? 1
    if (used + cost > rowBudget) {
      // One side is full; try the other before giving up.
      const other = takeUp ? rows[end] : rows[start - 1]
      const otherCost = other?.lines ?? 1
      const canTakeOther = takeUp ? canGrowDown : canGrowUp
      if (!canTakeOther || used + otherCost > rowBudget) break
      if (takeUp) end++
      else start--
      used += otherCost
      continue
    }
    if (takeUp) start--
    else end++
    used += cost
  }
  return { start, end, before: start, after: rows.length - end }
}

export interface OverlayView {
  readonly title: string
  readonly hint: string
  readonly rows: readonly string[]
  /** Set when entries are hidden, e.g. `↑ 3 more`. */
  readonly above?: string
  readonly below?: string
}

export interface OverlayOptions {
  readonly title: string
  readonly hint: string
  readonly columns: number
  readonly rowBudget: number
  /** Marker for the focused row; one cell so the budget is unaffected. */
  readonly marker?: string
  readonly emptyText?: string
}

/** Render the visible slice into bounded text rows. */
export function buildOverlay(
  rows: readonly OverlayRow[],
  selectedIndex: number,
  options: OverlayOptions,
): OverlayView {
  const marker = options.marker ?? '>'
  const columns = Math.max(1, options.columns)
  if (rows.length === 0) {
    return {
      title: truncateToWidth(options.title, columns),
      hint: truncateToWidth(options.hint, columns),
      rows: [truncateToWidth(options.emptyText ?? 'no matches', columns)],
    }
  }
  const window = overlayWindow(rows, selectedIndex, options.rowBudget)
  const focus = Math.max(0, Math.min(selectedIndex, rows.length - 1))
  const text: string[] = []
  for (let index = window.start; index < window.end; index++) {
    const row = rows[index]
    if (row === undefined) continue
    const prefix = index === focus ? `${marker} ` : '  '
    text.push(truncateToWidth(`${prefix}${row.text}`, columns))
    if (row.lines > 1 && row.description !== undefined) {
      text.push(truncateToWidth(`    ${row.description}`, columns))
    }
  }
  return {
    title: truncateToWidth(options.title, columns),
    hint: truncateToWidth(options.hint, columns),
    rows: text,
    ...(window.before === 0 ? {} : { above: `↑ ${String(window.before)} more` }),
    ...(window.after === 0 ? {} : { below: `↓ ${String(window.after)} more` }),
  }
}

/**
 * Pick the widest hint variant that fits.
 *
 * Truncating a hint eats its tail, and the tail is where the keys nobody can
 * guess live. Dropping to a shorter written form keeps every key it still
 * mentions readable.
 */
export function fitHint(variants: readonly string[], columns: number): string {
  for (const variant of variants) {
    if (truncateToWidth(variant, columns) === variant) return variant
  }
  return truncateToWidth(variants.at(-1) ?? '', columns)
}

/**
 * Group the binding table into rows for the shortcut sheet.
 *
 * Generated from `KEY_BINDINGS` rather than written out again, so the sheet
 * cannot drift from what the resolver actually does.
 */
export function helpRows(
  bindings: readonly { keys: string; surface: string; description: string }[],
  keyColumn = 18,
): readonly OverlayRow[] {
  const order = ['global', 'composer', 'transcript', 'approval', 'question', 'palette', 'picker']
  const rows: OverlayRow[] = []
  for (const surface of order) {
    const group = bindings.filter(binding => binding.surface === surface)
    if (group.length === 0) continue
    rows.push({ id: `group:${surface}`, text: `${surface}:`, lines: 1 })
    for (const binding of group) {
      rows.push({
        id: `${surface}:${binding.keys}`,
        text: `  ${binding.keys.padEnd(keyColumn)}${binding.description}`,
        lines: 1,
      })
    }
  }
  return rows
}
