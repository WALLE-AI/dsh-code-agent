export interface ViewportState {
  readonly offsetFromBottom: number
  readonly unread: number
  readonly lineCount: number
  readonly revision: number
}

export const emptyViewport: ViewportState = Object.freeze({
  offsetFromBottom: 0,
  unread: 0,
  lineCount: 0,
  revision: 0,
})

export function syncViewport(
  state: ViewportState,
  lineCount: number,
  revision: number,
  capacity: number,
): ViewportState {
  const added = Math.max(0, lineCount - state.lineCount)
  const maximum = Math.max(0, lineCount - capacity)
  if (state.offsetFromBottom === 0) {
    return { offsetFromBottom: 0, unread: 0, lineCount, revision }
  }
  const changed = revision !== state.revision
  const offsetFromBottom = Math.min(maximum, state.offsetFromBottom + added)
  return {
    offsetFromBottom,
    unread: offsetFromBottom === 0 ? 0 : changed ? state.unread + Math.max(1, added) : state.unread,
    lineCount,
    revision,
  }
}

export function scrollViewport(
  state: ViewportState,
  direction: -1 | 1,
  amount: number,
  capacity: number,
): ViewportState {
  const maximum = Math.max(0, state.lineCount - capacity)
  const offset = direction === -1
    ? Math.min(maximum, state.offsetFromBottom + Math.max(1, amount))
    : Math.max(0, state.offsetFromBottom - Math.max(1, amount))
  return { ...state, offsetFromBottom: offset, unread: offset === 0 ? 0 : state.unread }
}

export function viewportLines<T>(
  lines: readonly T[],
  state: ViewportState,
  capacity: number,
): readonly T[] {
  const end = Math.max(0, lines.length - state.offsetFromBottom)
  return lines.slice(Math.max(0, end - capacity), end)
}
