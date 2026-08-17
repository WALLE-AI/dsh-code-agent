/**
 * Bounded workspace path listing for `@` mention completion.
 *
 * The scan is deliberately shallow and capped: a mention menu is a convenience,
 * not a file search, and a deep walk on a large repository would stall the
 * render loop. Directory reads are injected so the walk can be tested without
 * touching a disk.
 */

import type { FileCandidate } from './draft-completion.ts'

export interface DirectoryEntry {
  readonly name: string
  readonly directory: boolean
}

/** Reads one directory, relative to the workspace root. `''` is the root. */
export type ReadDirectory = (relativePath: string) => readonly DirectoryEntry[]

export interface ListWorkspaceOptions {
  /** Directories never descended into or offered. */
  readonly ignore?: ReadonlySet<string>
  /** Upper bound on returned candidates. */
  readonly limit?: number
  /** Upper bound on directory levels below the prefix. */
  readonly depth?: number
}

const DEFAULT_IGNORE: ReadonlySet<string> = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.venv',
  '__pycache__', 'target', 'vendor',
])

const DEFAULT_LIMIT = 200
const DEFAULT_DEPTH = 2

function join(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`
}

/**
 * List candidates for a mention prefix.
 *
 * The prefix's leading directory component anchors the walk, so typing
 * `@packages/dsh` searches inside `packages/` instead of re-walking the root.
 */
export function listWorkspaceFiles(
  prefix: string,
  read: ReadDirectory,
  options: ListWorkspaceOptions = {},
): readonly FileCandidate[] {
  const ignore = options.ignore ?? DEFAULT_IGNORE
  const limit = options.limit ?? DEFAULT_LIMIT
  const depth = options.depth ?? DEFAULT_DEPTH
  // Everything up to the last separator is a directory the user already typed.
  const separator = prefix.lastIndexOf('/')
  const root = separator === -1 ? '' : prefix.slice(0, separator)
  if (root.split('/').some(part => part === '..')) return []

  const candidates: FileCandidate[] = []
  const queue: { path: string; level: number }[] = [{ path: root, level: 0 }]
  while (queue.length > 0 && candidates.length < limit) {
    const next = queue.shift()
    if (next === undefined) break
    let entries: readonly DirectoryEntry[]
    try {
      entries = read(next.path)
    } catch {
      // An unreadable directory is skipped, never fatal: completion degrades to
      // whatever else the walk found.
      continue
    }
    for (const entry of entries) {
      if (candidates.length >= limit) break
      if (entry.name.startsWith('.') || ignore.has(entry.name)) continue
      const path = join(next.path, entry.name)
      candidates.push({ path, directory: entry.directory })
      if (entry.directory && next.level < depth) queue.push({ path, level: next.level + 1 })
    }
  }
  return candidates
}
