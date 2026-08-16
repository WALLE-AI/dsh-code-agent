import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  editorArgv, EditorLauncher, resolveEditor, resolveWorkspacePath,
} from '../src/editor-launcher.ts'

const workspace = resolve('/repo')

describe('editor resolution', () => {
  it('prefers the configured argv, then VISUAL, then EDITOR', () => {
    expect(resolveEditor({ VISUAL: 'vim', EDITOR: 'nano' }, ['code', '-r'])).toEqual(['code', '-r'])
    expect(resolveEditor({ VISUAL: 'vim', EDITOR: 'nano' })).toEqual(['vim'])
    expect(resolveEditor({ EDITOR: 'nvim -p' })).toEqual(['nvim', '-p'])
    expect(resolveEditor({})).toBeUndefined()
  })

  it('refuses editors that carry shell syntax', () => {
    expect(resolveEditor({ EDITOR: 'vim; rm -rf /' })).toBeUndefined()
    expect(resolveEditor({ EDITOR: 'sh -c "curl evil"' })).toBeUndefined()
    expect(resolveEditor({ EDITOR: 'vim $(whoami)' })).toBeUndefined()
  })

  it('builds argv arrays per editor family, never a shell string', () => {
    expect(editorArgv(['vim'], '/repo/a.ts', 12)).toEqual({ command: 'vim', args: ['+12', '/repo/a.ts'] })
    expect(editorArgv(['code'], '/repo/a.ts', 12))
      .toEqual({ command: 'code', args: ['--goto', '/repo/a.ts:12'] })
    expect(editorArgv(['idea'], '/repo/a.ts', 3))
      .toEqual({ command: 'idea', args: ['--line', '3', '/repo/a.ts'] })
    expect(editorArgv(['myeditor', '--wait'], '/repo/a.ts', 3))
      .toEqual({ command: 'myeditor', args: ['--wait', '/repo/a.ts'] })
    expect(editorArgv(['vim'], '/repo/a.ts')).toEqual({ command: 'vim', args: ['/repo/a.ts'] })
  })
})

describe('workspace boundary', () => {
  it('accepts paths inside the workspace', () => {
    expect(resolveWorkspacePath(workspace, 'src/a.ts')).toBe(resolve(workspace, 'src/a.ts'))
    expect(resolveWorkspacePath(workspace, resolve(workspace, 'src/a.ts')))
      .toBe(resolve(workspace, 'src/a.ts'))
  })

  it('rejects traversal and absolute paths outside the workspace', () => {
    expect(() => resolveWorkspacePath(workspace, '../secrets.txt')).toThrow('outside the workspace')
    expect(() => resolveWorkspacePath(workspace, 'src/../../secrets.txt')).toThrow('outside the workspace')
    expect(() => resolveWorkspacePath(workspace, resolve('/etc/passwd'))).toThrow('outside the workspace')
  })
})

describe('editor launcher', () => {
  it('spawns the editor with an argv array and reports the outcome', () => {
    const spawn = vi.fn()
    const launcher = new EditorLauncher({ workspace, editor: ['code'], spawn })
    const message = launcher.open({ path: 'src/a.ts', line: 42 })
    expect(spawn).toHaveBeenCalledWith('code', ['--goto', `${resolve(workspace, 'src/a.ts')}:42`], workspace)
    expect(message).toContain('src')
    expect(message).toContain(':42')
  })

  it('fails closed without an editor and for out-of-workspace locations', () => {
    const spawn = vi.fn()
    expect(() => new EditorLauncher({ workspace, env: {}, spawn }).open({ path: 'a.ts' }))
      .toThrow('no editor configured')
    expect(() => new EditorLauncher({ workspace, editor: ['vim'], spawn }).open({ path: '../a.ts' }))
      .toThrow('outside the workspace')
    expect(spawn).not.toHaveBeenCalled()
  })
})
