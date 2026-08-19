/**
 * The archive format the single-file executable carries.
 *
 * Deliberately not tar: the payload is a `node_modules` tree, whose paths run
 * past the 100-byte name field that plain tar allows, and every workaround
 * (ustar prefix splitting, GNU LongLink, pax headers) is a format edge case the
 * extractor would have to get right on the target machine with no way to test
 * it there. A format written and read by these two functions has no edge cases
 * that are not visible here.
 *
 * Layout:
 *
 *   magic    "DSHC1\n"
 *   header   8 bytes: index length, then payload length, both little-endian u32
 *   index    gzipped JSON: [{ p: relative path, o: offset, l: length, x: executable }]
 *   payload  gzipped concatenation of every file, in index order
 *
 * Offsets are into the *uncompressed* payload, so extraction is one gunzip and
 * then a slice per file.
 *
 * This module is imported by the packaging script; the extractor in
 * `main.cjs` reads the same layout without importing anything, because it runs
 * inside the executable before any of this exists on disk.
 */

import { gzipSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export const MAGIC = 'DSHC1\n'

/**
 * Every file under `directory`, depth-first, as paths relative to it.
 *
 * @param {string} directory
 * @returns {string[]}
 */
export function listFiles(directory) {
  /** @type {string[]} */
  const files = []
  const walk = (/** @type {string} */ current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const full = join(current, entry.name)
      // Symlinks inside the bundle are npm's .bin shims; they are recreated as
      // real files by the extractor, so they are followed here rather than
      // preserved.
      if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(full).isDirectory())) walk(full)
      else files.push(relative(directory, full).split(sep).join('/'))
    }
  }
  walk(directory)
  return files
}

/**
 * Pack a directory into a single buffer in the layout described above.
 *
 * @param {string} directory
 * @returns {{ archive: Buffer, fileCount: number, rawBytes: number }}
 */
export function packDirectory(directory) {
  const files = listFiles(directory)
  /** @type {{ p: string, o: number, l: number, x: boolean }[]} */
  const index = []
  /** @type {Buffer[]} */
  const chunks = []
  let offset = 0
  for (const path of files) {
    const full = join(directory, path)
    const contents = readFileSync(full)
    const executable = (statSync(full).mode & 0o111) !== 0
    index.push({ p: path, o: offset, l: contents.length, x: executable })
    chunks.push(contents)
    offset += contents.length
  }
  const payload = gzipSync(Buffer.concat(chunks), { level: 9 })
  const indexBuffer = gzipSync(Buffer.from(JSON.stringify(index), 'utf8'), { level: 9 })
  const header = Buffer.alloc(8)
  header.writeUInt32LE(indexBuffer.length, 0)
  header.writeUInt32LE(payload.length, 4)
  return {
    archive: Buffer.concat([Buffer.from(MAGIC, 'ascii'), header, indexBuffer, payload]),
    fileCount: files.length,
    rawBytes: offset,
  }
}
