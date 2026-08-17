/**
 * Session browser model.
 *
 * A screen rather than an overlay: it replaces the conversation instead of
 * floating over it, so there is nothing underneath to repaint or bleed through.
 *
 * Two rules are worth stating because both were arrived at the hard way in
 * terminal browsers generally:
 *
 * - The cursor is an **id**, not an index. Filtering, deleting or a refreshed
 *   listing all reorder the rows; an index quietly lands the cursor on a
 *   different session, and the next Enter resumes the wrong one.
 * - There is no "enter search mode". Typing filters, because the list *is* the
 *   result — a mode you can be in without noticing is a mode that will answer
 *   for you.
 */

import type { TuiSessionSummary } from './session-selector.ts'

/** Below this the preview is dropped and the list gets the whole width. */
export const SPLIT_MIN_COLUMNS = 100

export interface BrowserState {
  readonly query: string
  /** Session id under the cursor; `undefined` before the first listing. */
  readonly focusId?: string
  /** A resume was requested and has not landed yet. */
  readonly resuming: boolean
}

export const emptyBrowser: BrowserState = Object.freeze({ query: '', resuming: false })

/** Control characters would corrupt the row; a paste must not smuggle them in. */
function clean(text: string): string {
  return text.replace(/\p{Cc}/gu, '')
}

/** Filter the listing by the query, matching id and working directory. */
export function browserMatches(
  sessions: readonly TuiSessionSummary[],
  query: string,
): readonly TuiSessionSummary[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return sessions
  return sessions.filter(session =>
    session.id.toLowerCase().includes(needle)
    || (session.cwd ?? '').toLowerCase().includes(needle))
}

/** Index of the focused row, clamped into the current matches. */
export function browserFocusIndex(
  matches: readonly TuiSessionSummary[],
  state: BrowserState,
): number {
  if (matches.length === 0) return 0
  const found = matches.findIndex(session => session.id === state.focusId)
  return found === -1 ? 0 : found
}

/** Move the cursor, carrying the *id* so a reorder cannot move it for you. */
export function moveBrowser(
  state: BrowserState,
  matches: readonly TuiSessionSummary[],
  delta: number,
): BrowserState {
  if (matches.length === 0) return state
  const next = Math.max(0, Math.min(
    matches.length - 1,
    browserFocusIndex(matches, state) + delta,
  ))
  const id = matches[next]?.id
  return id === undefined ? state : { ...state, focusId: id }
}

export function typeBrowser(state: BrowserState, text: string): BrowserState {
  const added = clean(text)
  // A new query can move the match set out from under the cursor, so the focus
  // is released and re-derived from the first row.
  return added === ''
    ? state
    : { query: state.query + added, resuming: false }
}

export function backspaceBrowser(state: BrowserState): BrowserState {
  const characters = Array.from(state.query)
  characters.pop()
  return { ...state, query: characters.join(''), resuming: false }
}

/**
 * What Esc does next. It peels exactly one layer per press: a non-empty query
 * first, the screen second.
 */
export function escapeBrowser(state: BrowserState): { state: BrowserState; close: boolean } {
  if (state.query !== '') return { state: { ...state, query: '', resuming: false }, close: false }
  return { state, close: true }
}

export interface BrowserView {
  readonly title: string
  readonly rows: readonly string[]
  readonly hint: string
  /** Whether the preview column has room; the caller renders it. */
  readonly split: boolean
  readonly empty: boolean
}

/** True when the listing has arrived and simply has nothing in it. */
export function browserEmptyText(query: string): string {
  return query === '' ? 'no resumable sessions' : `no session matches "${query}"`
}
