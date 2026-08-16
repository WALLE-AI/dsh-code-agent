/**
 * Session selection. Records come from the Harness session query service; the
 * TUI never scans persistence files or guesses ids from disk layout.
 */

import { sanitizeLine, truncateToWidth } from './terminal-text.ts'

export interface TuiSessionSummary {
  readonly id: string
  readonly createdAt: number
  readonly live: boolean
  readonly persisted: boolean
  readonly cwd?: string
  readonly origin?: string
}

export interface SessionListOptions {
  /** Keep sessions created by subagents out of the resume list. */
  readonly includeSubagents?: boolean
  /** Restrict to sessions created in this working directory. */
  readonly cwd?: string
}

/** Newest-first list of the sessions a user may resume. */
export function selectableSessions(
  records: readonly TuiSessionSummary[],
  options: SessionListOptions = {},
): readonly TuiSessionSummary[] {
  return records
    .filter(record => options.includeSubagents === true || record.origin !== 'subagent')
    .filter(record => options.cwd === undefined || record.cwd === options.cwd)
    .filter(record => record.live || record.persisted)
    .slice()
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
}

/**
 * Resolve a `--resume` argument against the selectable list.
 * @param requested - `latest`, a full id, or an unambiguous id prefix.
 * @throws when nothing matches or a prefix is ambiguous.
 */
export function resolveSessionSelection(
  records: readonly TuiSessionSummary[],
  requested: string,
): string {
  const sessions = selectableSessions(records)
  const needle = requested.trim()
  if (needle === '' || needle === 'latest') {
    const newest = sessions[0]
    if (newest === undefined) throw new Error('no resumable session was found')
    return newest.id
  }
  const exact = sessions.find(session => session.id === needle)
  if (exact !== undefined) return exact.id
  const prefixed = sessions.filter(session => session.id.startsWith(needle))
  if (prefixed.length === 1) return prefixed[0]!.id
  if (prefixed.length > 1) {
    throw new Error(`session id ${needle} is ambiguous across ${String(prefixed.length)} sessions`)
  }
  throw new Error(`no resumable session matches ${needle}`)
}

/** One selector row: id, age, state, and workspace. */
export function formatSessionRow(
  session: TuiSessionSummary,
  columns: number,
  now: number,
): string {
  const ageMinutes = Math.max(0, Math.round((now - session.createdAt) / 60_000))
  const age = ageMinutes < 60
    ? `${String(ageMinutes)}m`
    : ageMinutes < 60 * 24
      ? `${String(Math.round(ageMinutes / 60))}h`
      : `${String(Math.round(ageMinutes / (60 * 24)))}d`
  const state = session.live ? 'live' : session.persisted ? 'saved' : 'unknown'
  const cwd = session.cwd === undefined ? '' : `  ${sanitizeLine(session.cwd)}`
  return truncateToWidth(`${session.id}  ${age.padStart(4)}  ${state}${cwd}`, columns)
}
