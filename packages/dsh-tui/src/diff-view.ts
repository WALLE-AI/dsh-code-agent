/**
 * Unified-diff view model. Tools hand over before/after text; the terminal needs
 * bounded, line-numbered hunks plus honest add/remove statistics.
 */

export interface DiffRow {
  readonly marker: ' ' | '+' | '-' | '@'
  readonly text: string
  readonly oldLine?: number
  readonly newLine?: number
}

export interface DiffFileView {
  readonly path: string
  readonly binary: boolean
  readonly created: boolean
  readonly added: number
  readonly removed: number
  readonly rows: readonly DiffRow[]
  /** Rows dropped because the file exceeded the row budget. */
  readonly droppedRows: number
}

export interface DiffOptions {
  /** Unchanged lines kept around each change. */
  readonly context?: number
  /** Maximum rows retained for one file. */
  readonly maxRows?: number
  /**
   * Above this line-pair product the exact diff is skipped and the file is
   * reported as a whole-file replacement instead of blocking the render loop.
   */
  readonly maxDiffCells?: number
}

const DEFAULTS = { context: 3, maxRows: 200, maxDiffCells: 250_000 } as const

type Operation =
  | { readonly kind: 'equal'; readonly text: string; readonly oldLine: number; readonly newLine: number }
  | { readonly kind: 'remove'; readonly text: string; readonly oldLine: number }
  | { readonly kind: 'add'; readonly text: string; readonly newLine: number }

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

const NUL = String.fromCharCode(0)

function isBinary(text: string | null): boolean {
  return text !== null && text.includes(NUL)
}

/** Longest-common-subsequence line operations. Callers must apply the cell guard. */
function operations(before: readonly string[], after: readonly string[]): Operation[] {
  const rows = before.length
  const columns = after.length
  const lengths: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      lengths[i]![j] = before[i] === after[j]
        ? lengths[i + 1]![j + 1]! + 1
        : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const result: Operation[] = []
  let i = 0
  let j = 0
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      result.push({ kind: 'equal', text: before[i]!, oldLine: i + 1, newLine: j + 1 })
      i++
      j++
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      result.push({ kind: 'remove', text: before[i]!, oldLine: i + 1 })
      i++
    } else {
      result.push({ kind: 'add', text: after[j]!, newLine: j + 1 })
      j++
    }
  }
  while (i < rows) { result.push({ kind: 'remove', text: before[i]!, oldLine: i + 1 }); i++ }
  while (j < columns) { result.push({ kind: 'add', text: after[j]!, newLine: j + 1 }); j++ }
  return result
}

function wholeFileReplacement(before: readonly string[], after: readonly string[]): Operation[] {
  return [
    ...before.map((text, index): Operation => ({ kind: 'remove', text, oldLine: index + 1 })),
    ...after.map((text, index): Operation => ({ kind: 'add', text, newLine: index + 1 })),
  ]
}

/** Keep changed runs plus `context` unchanged lines, separated by hunk headers. */
function toRows(ops: readonly Operation[], context: number): DiffRow[] {
  const keep = new Array<boolean>(ops.length).fill(false)
  ops.forEach((operation, index) => {
    if (operation.kind === 'equal') return
    for (let offset = -context; offset <= context; offset++) {
      const target = index + offset
      if (target >= 0 && target < ops.length) keep[target] = true
    }
  })
  const rows: DiffRow[] = []
  let inHunk = false
  ops.forEach((operation, index) => {
    if (!keep[index]) {
      inHunk = false
      return
    }
    if (!inHunk) {
      const oldStart = 'oldLine' in operation ? operation.oldLine : undefined
      const newStart = 'newLine' in operation ? operation.newLine : undefined
      rows.push({
        marker: '@',
        text: `@@ -${String(oldStart ?? 0)} +${String(newStart ?? 0)} @@`,
      })
      inHunk = true
    }
    rows.push({
      marker: operation.kind === 'equal' ? ' ' : operation.kind === 'add' ? '+' : '-',
      text: operation.text,
      ...('oldLine' in operation ? { oldLine: operation.oldLine } : {}),
      ...('newLine' in operation ? { newLine: operation.newLine } : {}),
    })
  })
  return rows
}

/** Build one file's bounded diff view; `oldText === null` marks a created file. */
export function buildFileDiff(
  path: string,
  oldText: string | null,
  newText: string,
  options: DiffOptions = {},
): DiffFileView {
  const { context, maxRows, maxDiffCells } = { ...DEFAULTS, ...options }
  const created = oldText === null
  if (isBinary(oldText) || isBinary(newText)) {
    return {
      path, binary: true, created, added: 0, removed: 0,
      rows: [{ marker: '@', text: 'binary file not shown' }], droppedRows: 0,
    }
  }
  const before = splitLines(oldText ?? '')
  const after = splitLines(newText)
  const ops = before.length * after.length > maxDiffCells
    ? wholeFileReplacement(before, after)
    : operations(before, after)
  const added = ops.filter(operation => operation.kind === 'add').length
  const removed = ops.filter(operation => operation.kind === 'remove').length
  const rows = toRows(ops, context)
  return {
    path,
    binary: false,
    created,
    added,
    removed,
    rows: rows.slice(0, maxRows),
    droppedRows: Math.max(0, rows.length - maxRows),
  }
}

/** Render one file view as terminal rows, prefixed with markers and line numbers. */
export function diffRowText(row: DiffRow, showLineNumbers: boolean): string {
  if (row.marker === '@') return row.text
  if (!showLineNumbers) return `${row.marker}${row.text}`
  const line = row.marker === '-' ? row.oldLine : row.newLine
  return `${row.marker}${String(line ?? '').padStart(5)} ${row.text}`
}
