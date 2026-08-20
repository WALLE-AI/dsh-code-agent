/**
 * Session selection. Records come from the Harness session query service; the
 * TUI never scans persistence files or guesses ids from disk layout.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
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

export interface SessionResolveOptions {
  /** `latest` is scoped to this directory; explicit ids are checked against it. */
  readonly cwd?: string
}

/** Resolve an existing directory when possible and still normalize stale paths. */
export function canonicalSessionCwd(cwd: string): string {
  const absolute = resolve(cwd)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function sameWorkspace(left: string | undefined, right: string): boolean {
  return left !== undefined && canonicalSessionCwd(left) === canonicalSessionCwd(right)
}

/** Newest-first list of the sessions a user may resume. */
export function selectableSessions(
  records: readonly TuiSessionSummary[],
  options: SessionListOptions = {},
): readonly TuiSessionSummary[] {
  return records
    .filter(record => options.includeSubagents === true || record.origin !== 'subagent')
    .filter(record => options.cwd === undefined || sameWorkspace(record.cwd, options.cwd))
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
  options: SessionResolveOptions = {},
): string {
  const sessions = selectableSessions(records)
  const needle = requested.trim()
  if (needle === '' || needle === 'latest') {
    const newest = options.cwd === undefined
      ? sessions[0]
      : selectableSessions(records, { cwd: options.cwd })[0]
    if (newest === undefined) {
      throw new Error(options.cwd === undefined
        ? 'no resumable session was found'
        : `no resumable session was found in ${canonicalSessionCwd(options.cwd)}`)
    }
    return newest.id
  }
  const exact = sessions.find(session => session.id === needle)
  if (exact !== undefined) return checkedWorkspace(exact, options.cwd)
  const prefixed = sessions.filter(session => session.id.startsWith(needle))
  if (prefixed.length === 1) return checkedWorkspace(prefixed[0]!, options.cwd)
  if (prefixed.length > 1) {
    throw new Error(`session id ${needle} is ambiguous across ${String(prefixed.length)} sessions`)
  }
  throw new Error(`no resumable session matches ${needle}`)
}

function checkedWorkspace(session: TuiSessionSummary, cwd: string | undefined): string {
  if (cwd === undefined || session.cwd === undefined || sameWorkspace(session.cwd, cwd)) return session.id
  const original = canonicalSessionCwd(session.cwd)
  throw new Error(
    `session ${session.id} belongs to ${original}; run: cd ${JSON.stringify(original)} && dshcodecli --resume ${session.id}`,
  )
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
