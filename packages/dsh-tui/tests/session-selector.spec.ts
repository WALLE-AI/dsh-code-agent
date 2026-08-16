import { describe, expect, it } from 'vitest'
import {
  formatSessionRow, resolveSessionSelection, selectableSessions, type TuiSessionSummary,
} from '../src/session-selector.ts'

const base = { live: false, persisted: true }
const records: readonly TuiSessionSummary[] = [
  { id: 'session-a1', createdAt: 3_000, cwd: '/repo', ...base },
  { id: 'session-b2', createdAt: 5_000, cwd: '/other', ...base, live: true },
  { id: 'session-c3', createdAt: 4_000, cwd: '/repo', ...base, origin: 'subagent' },
  { id: 'session-a9', createdAt: 1_000, cwd: '/repo', live: false, persisted: false },
]

describe('session selection', () => {
  it('lists newest first and hides subagent and unreachable sessions', () => {
    expect(selectableSessions(records).map(session => session.id))
      .toEqual(['session-b2', 'session-a1'])
    expect(selectableSessions(records, { includeSubagents: true }).map(session => session.id))
      .toEqual(['session-b2', 'session-c3', 'session-a1'])
    expect(selectableSessions(records, { cwd: '/repo' }).map(session => session.id))
      .toEqual(['session-a1'])
  })

  it('resolves latest, exact ids, and unambiguous prefixes', () => {
    expect(resolveSessionSelection(records, 'latest')).toBe('session-b2')
    expect(resolveSessionSelection(records, '')).toBe('session-b2')
    expect(resolveSessionSelection(records, 'session-a1')).toBe('session-a1')
    expect(resolveSessionSelection(records, 'session-b')).toBe('session-b2')
  })

  it('fails loudly for missing and ambiguous selections', () => {
    expect(() => resolveSessionSelection(records, 'session-z')).toThrow('no resumable session matches')
    expect(() => resolveSessionSelection([], 'latest')).toThrow('no resumable session was found')
    const ambiguous: readonly TuiSessionSummary[] = [
      { id: 'session-a1', createdAt: 1, ...base },
      { id: 'session-a2', createdAt: 2, ...base },
    ]
    expect(() => resolveSessionSelection(ambiguous, 'session-a')).toThrow('ambiguous')
  })

  it('formats one bounded selector row', () => {
    const row = formatSessionRow(
      { id: 'session-a1', createdAt: 0, live: true, persisted: true, cwd: '/repo' },
      80,
      3_600_000,
    )
    expect(row).toContain('session-a1')
    expect(row).toContain('1h')
    expect(row).toContain('live')
    expect(formatSessionRow(
      { id: 'session-a1', createdAt: 0, live: false, persisted: true },
      12,
      0,
    ).length).toBeLessThanOrEqual(12)
  })
})
