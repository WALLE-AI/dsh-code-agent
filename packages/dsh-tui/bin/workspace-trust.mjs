import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const STORE_VERSION = 1
const CSI = '\x1b['

/** @param {string} path */
export function canonicalWorkspace(path) {
  return realpathSync(resolve(path))
}

/** @param {unknown} value */
function parseStore(value) {
  if (typeof value !== 'object' || value === null) return new Set()
  const record = /** @type {{ version?: unknown, workspaces?: unknown }} */ (value)
  if (record.version !== STORE_VERSION || !Array.isArray(record.workspaces)) return new Set()
  return new Set(record.workspaces.filter(item => typeof item === 'string'))
}

/** A damaged or unreadable store fails closed: no workspace is considered trusted. @param {string} path */
export function readTrustedWorkspaces(path) {
  try {
    return parseStore(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return new Set()
  }
}

/**
 * Persist one canonical workspace with an atomic replace and private permissions.
 * @param {string} storePath
 * @param {string} workspace
 */
export function trustWorkspace(storePath, workspace) {
  const trusted = readTrustedWorkspaces(storePath)
  trusted.add(workspace)
  const directory = dirname(storePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.trusted-workspaces.${String(process.pid)}.${String(Date.now())}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify({
      version: STORE_VERSION,
      workspaces: [...trusted].sort(),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, storePath)
    chmodSync(storePath, 0o600)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* nothing was materialised */ }
    throw error
  }
}

/** @param {string} workspace @param {string} storePath */
export function workspaceNeedsTrust(workspace, storePath) {
  return !readTrustedWorkspaces(storePath).has(workspace)
}

/** @param {string} text @param {number} columns */
function wrap(text, columns) {
  const width = Math.max(1, columns)
  const rows = []
  let rest = text
  while (rest.length > width) {
    let at = rest.lastIndexOf(' ', width)
    if (at <= 0) at = width
    rows.push(rest.slice(0, at))
    rest = rest.slice(at).trimStart()
  }
  rows.push(rest)
  return rows
}

/**
 * A deterministic frame used by both the raw prompt and snapshot-style tests.
 * @param {string} workspace
 * @param {0 | 1} selected
 * @param {number} [columns]
 */
export function renderWorkspaceTrust(workspace, selected, columns = 80) {
  const content = [
    'Accessing workspace:',
    '',
    ...wrap(workspace, columns),
    '',
    ...wrap('Quick safety check: Is this a project you created or one you trust?', columns),
    ...wrap('DSH Code Agent will be able to read, edit, and execute files here.', columns),
    '',
    `${selected === 0 ? '>' : ' '} Yes, use this folder`,
    `${selected === 1 ? '>' : ' '} No, exit`,
    '',
    ...wrap('Enter to confirm - Esc to cancel', columns),
  ]
  return content.join('\n')
}

/**
 * @param {0 | 1} selected
 * @param {Buffer} input
 * @returns {{ selected: 0 | 1, result?: 'accepted' | 'rejected' | 'cancelled' }}
 */
export function reduceWorkspaceTrust(selected, input) {
  const text = input.toString('utf8')
  if (input.includes(3) || text === '\x1b') return { selected, result: 'cancelled' }
  let next = /** @type {0 | 1} */ (selected)
  if (text.includes('\x1b[A') || text === 'k') next = 0
  if (text.includes('\x1b[B') || text === 'j') next = 1
  if (text === 'y' || text === 'Y' || text === '1') return { selected: 0, result: 'accepted' }
  if (text === 'n' || text === 'N' || text === '2') return { selected: 1, result: 'rejected' }
  if (text.includes('\r') || text.includes('\n')) {
    return { selected: next, result: next === 0 ? 'accepted' : 'rejected' }
  }
  return { selected: next }
}

/**
 * @param {string} workspace
 * @param {{ stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream }} [io]
 * @returns {Promise<'accepted' | 'rejected' | 'cancelled' | 'unavailable'>}
 */
export async function promptWorkspaceTrust(workspace, io = {}) {
  const stdin = io.stdin ?? process.stdin
  const stdout = io.stdout ?? process.stdout
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') return 'unavailable'
  const wasRaw = stdin.isRaw === true
  let selected = /** @type {0 | 1} */ (0)
  return await new Promise((resolvePromise, rejectPromise) => {
    const restore = () => {
      stdin.off('data', onData)
      stdin.off('end', onEnd)
      stdin.off('error', onError)
      stdout.write(`${CSI}?25h${CSI}?1049l`)
      stdin.setRawMode(wasRaw)
      if (!wasRaw) stdin.pause()
    }
    /** @param {'accepted' | 'rejected' | 'cancelled'} result */
    const finish = (result) => {
      restore()
      resolvePromise(result)
    }
    const paint = () => {
      stdout.write(`${CSI}H${CSI}2J${renderWorkspaceTrust(workspace, selected, stdout.columns ?? 80)}`)
    }
    /** @param {Buffer | string} chunk */
    const onData = (chunk) => {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const next = reduceWorkspaceTrust(selected, input)
      selected = /** @type {0 | 1} */ (next.selected)
      if (next.result !== undefined) finish(next.result)
      else paint()
    }
    const onEnd = () => { finish('cancelled') }
    /** @param {unknown} error */
    const onError = (error) => {
      restore()
      rejectPromise(error)
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdout.write(`${CSI}?1049h${CSI}?25l`)
    stdin.on('data', onData)
    stdin.once('end', onEnd)
    stdin.once('error', onError)
    paint()
  })
}

/** @param {string} workspace */
export function isHomeWorkspace(workspace) {
  try { return workspace === canonicalWorkspace(homedir()) } catch { return false }
}
