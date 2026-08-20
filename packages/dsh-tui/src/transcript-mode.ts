import type { TranscriptLine } from './transcript-view.ts'

export interface TranscriptModeState {
  readonly cursor: number
  readonly top: number
  readonly query: string
  readonly searchDraft?: string | undefined
  readonly notice?: string | undefined
}

export function openTranscriptMode(lineCount: number, capacity: number): TranscriptModeState {
  const cursor = Math.max(0, lineCount - 1)
  return { cursor, top: Math.max(0, lineCount - Math.max(1, capacity)), query: '' }
}

function reveal(cursor: number, top: number, lineCount: number, capacity: number): { cursor: number; top: number } {
  const bounded = Math.max(0, Math.min(Math.max(0, lineCount - 1), cursor))
  const size = Math.max(1, capacity)
  const nextTop = bounded < top
    ? bounded
    : bounded >= top + size ? bounded - size + 1 : top
  return { cursor: bounded, top: Math.max(0, Math.min(nextTop, Math.max(0, lineCount - size))) }
}

export function moveTranscriptCursor(
  state: TranscriptModeState,
  delta: number,
  lineCount: number,
  capacity: number,
): TranscriptModeState {
  return { ...state, ...reveal(state.cursor + delta, state.top, lineCount, capacity), notice: undefined }
}

export function transcriptMatches(lines: readonly TranscriptLine[], query: string): readonly number[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return []
  return lines.flatMap((line, index) => line.text.toLocaleLowerCase().includes(needle) ? [index] : [])
}

export function commitTranscriptSearch(
  state: TranscriptModeState,
  lines: readonly TranscriptLine[],
  capacity: number,
): TranscriptModeState {
  const query = state.searchDraft ?? state.query
  const matches = transcriptMatches(lines, query)
  const target = matches.find(index => index >= state.cursor) ?? matches[0]
  const base = { ...state, query, searchDraft: undefined }
  return target === undefined
    ? { ...base, notice: query === '' ? undefined : 'no matches' }
    : { ...base, ...reveal(target, state.top, lines.length, capacity), notice: undefined }
}

export function jumpTranscriptMatch(
  state: TranscriptModeState,
  lines: readonly TranscriptLine[],
  direction: -1 | 1,
  capacity: number,
): TranscriptModeState {
  const matches = transcriptMatches(lines, state.query)
  if (matches.length === 0) return { ...state, notice: state.query === '' ? 'search with /' : 'no matches' }
  const target = direction === 1
    ? matches.find(index => index > state.cursor) ?? matches[0]
    : [...matches].reverse().find(index => index < state.cursor) ?? matches[matches.length - 1]
  return { ...state, ...reveal(target ?? 0, state.top, lines.length, capacity), notice: undefined }
}

export function visibleTranscriptLines(
  state: TranscriptModeState,
  lines: readonly TranscriptLine[],
  capacity: number,
): readonly TranscriptLine[] {
  return lines.slice(state.top, state.top + Math.max(1, capacity))
}

export function copyTranscriptText(
  state: TranscriptModeState,
  lines: readonly TranscriptLine[],
  wholeEntry: boolean,
): string {
  const line = lines[state.cursor]
  if (line === undefined) return ''
  return wholeEntry
    ? lines.filter(candidate => candidate.entryId === line.entryId).map(candidate => candidate.text).join('\n')
    : line.text
}
