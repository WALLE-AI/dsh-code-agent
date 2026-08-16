/**
 * Editor launch for tool locations. Paths are validated against the workspace
 * and passed as an argv array; no part of a location ever reaches a shell.
 */

import { spawn } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'

export interface EditorLocation {
  readonly path: string
  readonly line?: number
}

export interface EditorSpawn {
  (command: string, args: readonly string[], cwd: string): void
}

export interface EditorLauncherOptions {
  readonly workspace: string
  readonly editor?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly spawn: EditorSpawn
}

/** Resolve the configured editor argv, then `$VISUAL`, then `$EDITOR`. */
export function resolveEditor(
  env: NodeJS.ProcessEnv = process.env,
  override?: readonly string[],
): readonly string[] | undefined {
  if (override !== undefined && override.length > 0) return override
  const configured = (env.VISUAL ?? env.EDITOR ?? '').trim()
  if (configured === '') return undefined
  // Only a plain command with flags is accepted; quoting and shell operators are not.
  if (/[|&;<>$`\\"']/.test(configured)) return undefined
  const parts = configured.split(/\s+/).filter(part => part !== '')
  return parts.length === 0 ? undefined : parts
}

/**
 * Reject any location that escapes the workspace, then return its absolute path.
 * @throws when the location leaves the workspace root.
 */
export function resolveWorkspacePath(workspace: string, path: string): string {
  const root = resolve(workspace)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const inside = relative(root, target)
  if (inside === '') return target
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(`location ${path} is outside the workspace`)
  }
  return target
}

/** Build the argv for one editor family; unknown editors get `<editor> <path>`. */
export function editorArgv(
  editor: readonly string[],
  path: string,
  line?: number,
): { readonly command: string; readonly args: readonly string[] } {
  const command = editor[0] ?? ''
  const flags = editor.slice(1)
  const name = (command.split(/[\\/]/).at(-1) ?? command).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  if (line === undefined || line <= 0) return { command, args: [...flags, path] }
  switch (name) {
    case 'vim': case 'nvim': case 'vi': case 'nano': case 'emacs': case 'emacsclient': case 'kak':
      return { command, args: [...flags, `+${String(line)}`, path] }
    case 'code': case 'code-insiders': case 'codium': case 'cursor': case 'windsurf':
      return { command, args: [...flags, '--goto', `${path}:${String(line)}`] }
    case 'subl': case 'sublime_text': case 'zed':
      return { command, args: [...flags, `${path}:${String(line)}`] }
    case 'idea': case 'webstorm': case 'pycharm': case 'goland':
      return { command, args: [...flags, '--line', String(line), path] }
    default:
      return { command, args: [...flags, path] }
  }
}

/** Open tool locations in the user's editor without ever building a shell string. */
export class EditorLauncher {
  constructor(private readonly options: EditorLauncherOptions) {}

  /**
   * Open one location.
   * @returns the human-readable outcome for the status line.
   * @throws when the location escapes the workspace.
   */
  open(location: EditorLocation): string {
    const editor = resolveEditor(this.options.env ?? process.env, this.options.editor)
    if (editor === undefined) {
      throw new Error('no editor configured; set $EDITOR or the tui editor option')
    }
    const target = resolveWorkspacePath(this.options.workspace, location.path)
    const { command, args } = editorArgv(editor, target, location.line)
    this.options.spawn(command, args, resolve(this.options.workspace))
    const suffix = location.line === undefined ? '' : `:${String(location.line)}`
    return `opened ${relative(resolve(this.options.workspace), target) || location.path}${suffix} in ${command}`
  }
}

/**
 * Detached spawn used by the running TUI: the child keeps no terminal handles,
 * so a GUI editor opens without disturbing the alternate screen. Terminal
 * editors that need the TTY are out of P0 scope.
 */
export function detachedSpawn(): EditorSpawn {
  return (command, args, cwd) => {
    const child = spawn(command, [...args], { cwd, detached: true, stdio: 'ignore', shell: false })
    child.on('error', () => { /* surfaced by the caller's notice */ })
    child.unref()
  }
}
