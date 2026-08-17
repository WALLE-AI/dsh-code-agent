import { describe, expect, it } from 'vitest'
import {
  backspaceBrowser, browserEmptyText, browserFocusIndex, browserMatches,
  emptyBrowser, escapeBrowser, moveBrowser, typeBrowser,
} from '../src/session-browser.ts'
import type { TuiSessionSummary } from '../src/session-selector.ts'

function session(id: string, cwd: string): TuiSessionSummary {
  return { id, createdAt: 1_000, live: false, persisted: true, cwd }
}

const SESSIONS: readonly TuiSessionSummary[] = [
  session('aaa-1', '/repo/alpha'),
  session('bbb-2', '/repo/beta'),
  session('ccc-3', '/other/gamma'),
]

describe('filtering', () => {
  it('matches on the id or the working directory', () => {
    expect(browserMatches(SESSIONS, 'bbb').map(s => s.id)).toEqual(['bbb-2'])
    expect(browserMatches(SESSIONS, 'repo').map(s => s.id)).toEqual(['aaa-1', 'bbb-2'])
  })

  it('shows everything for an empty or blank query', () => {
    expect(browserMatches(SESSIONS, '')).toHaveLength(3)
    expect(browserMatches(SESSIONS, '   ')).toHaveLength(3)
  })

  it('filters as you type, with no mode to enter first', () => {
    let state = emptyBrowser
    state = typeBrowser(state, 'b')
    expect(state.query).toBe('b')
    expect(browserMatches(SESSIONS, state.query).map(s => s.id)).toEqual(['bbb-2'])
    state = backspaceBrowser(state)
    expect(browserMatches(SESSIONS, state.query)).toHaveLength(3)
  })

  it('strips control characters a paste could smuggle in', () => {
    const state = typeBrowser(emptyBrowser, `a${String.fromCharCode(7)}b`)
    expect(state.query).toBe('ab')
  })
})

describe('cursor identity', () => {
  it('follows the session, not the row number, when the list reorders', () => {
    const state = { ...emptyBrowser, focusId: 'ccc-3' }
    // `ccc-3` is row 2 of the full list and row 0 of this filtered one.
    expect(browserFocusIndex(SESSIONS, state)).toBe(2)
    expect(browserFocusIndex(browserMatches(SESSIONS, 'gamma'), state)).toBe(0)
  })

  it('falls back to the first row when the focused session is gone', () => {
    const state = { ...emptyBrowser, focusId: 'deleted' }
    expect(browserFocusIndex(SESSIONS, state)).toBe(0)
  })

  it('moves by id and clamps at both ends', () => {
    let state = moveBrowser(emptyBrowser, SESSIONS, 1)
    expect(state.focusId).toBe('bbb-2')
    state = moveBrowser(state, SESSIONS, 1)
    expect(state.focusId).toBe('ccc-3')
    expect(moveBrowser(state, SESSIONS, 1).focusId).toBe('ccc-3')
    expect(moveBrowser(emptyBrowser, SESSIONS, -1).focusId).toBe('aaa-1')
  })

  it('is a no-op when nothing matches', () => {
    expect(moveBrowser(emptyBrowser, [], 1)).toEqual(emptyBrowser)
  })
})

describe('escape', () => {
  it('clears the query before it closes the screen', () => {
    const typed = typeBrowser(emptyBrowser, 'repo')
    const first = escapeBrowser(typed)
    expect(first.close).toBe(false)
    expect(first.state.query).toBe('')
    expect(escapeBrowser(first.state).close).toBe(true)
  })
})

describe('empty state', () => {
  it('says whether the listing is empty or the query is too narrow', () => {
    expect(browserEmptyText('')).toBe('no resumable sessions')
    expect(browserEmptyText('zzz')).toBe('no session matches "zzz"')
  })
})
