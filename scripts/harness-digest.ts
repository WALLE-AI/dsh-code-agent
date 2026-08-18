/**
 * Content digest of the vendored Harness source.
 *
 * The Harness is vendored as a source drop (`deepseek-harness-master`, an
 * archive export), so it has no `.git` of its own. `git rev-parse HEAD` run
 * inside it therefore walks up and answers with *this* repository's commit,
 * which is why the old commit pin passed for any harness and failed on every
 * commit we made. A digest over the source is the honest replacement: it is
 * strictly stronger than a commit id — it detects an edited working tree, which
 * a commit id cannot — and it needs no VCS metadata.
 *
 * Build outputs are excluded: they are regenerated locally and would make the
 * digest depend on whether anyone had run a build.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Regenerated locally, so never part of the identity of the source. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', 'lib', 'dist', 'build', '.git', '.turbo', 'coverage', '.cache',
])

/** The source languages and manifests the adapter boundary can depend on. */
const INCLUDE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|json)$/

function walk(root: string, directory: string, out: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      walk(root, full, out)
      continue
    }
    if (!entry.isFile() || !INCLUDE.test(entry.name)) continue
    out.push(relative(root, full))
  }
}

/**
 * Hash every source file under `packages/` plus the root manifest.
 *
 * Paths are normalised to `/` and sorted, so the digest is identical on Windows
 * and independent of directory iteration order. Each entry commits to both the
 * path and the bytes, so a rename is a change even when no content moved.
 */
export function harnessDigest(harness: string): string {
  const files: string[] = []
  walk(harness, join(harness, 'packages'), files)
  files.push('package.json')
  const digest = createHash('sha256')
  for (const file of files.map(path => path.split(sep).join('/')).sort()) {
    digest.update(file)
    digest.update('\0')
    digest.update(createHash('sha256').update(readFileSync(join(harness, file))).digest())
  }
  return digest.digest('hex')
}
