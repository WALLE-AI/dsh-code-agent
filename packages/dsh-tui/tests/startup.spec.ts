import { describe, expect, it, vi } from 'vitest'
import { apply, parseModelSelection, parsePermissionPreset, startupValues } from '../src/startup.ts'
import type { HarnessContext } from '../src/harness-adapter.ts'

function run(args: readonly string[]): { values: unknown; exit: ReturnType<typeof vi.fn> } {
  const exit = vi.fn()
  const values = new Map<string, unknown>([
    ['cmdlineArgs', { get: () => args }],
    ['appExit', exit],
  ])
  const ctx: HarnessContext = {
    get: name => values.get(name),
    provide: (name, value) => { values.set(name, value) },
  }
  apply(ctx)
  return { values: values.get('tuiStartup'), exit }
}

describe('TUI startup options', () => {
  it('enables semantic colors by default', () => {
    expect(run(['review', 'this']).values).toEqual({
      task: 'review this', alternateScreen: false, interactive: false, color: true,
    })
  })

  it('maps interactive, alternate-screen, and no-color independently', () => {
    expect(run(['--interactive', '--alternate-screen', '--no-color', 'ship']).values).toEqual({
      task: 'ship', alternateScreen: true, interactive: true, color: false,
    })
  })

  it('accepts resume with an id, with a prefix, and without a value', () => {
    expect(run(['--resume', 'session-a1']).values).toMatchObject({
      task: '', resume: 'session-a1', interactive: true,
    })
    expect(run(['--resume']).values).toMatchObject({ resume: 'latest', interactive: true })
    expect(run(['-r', 'session-a1']).values).toMatchObject({ resume: 'session-a1', interactive: true })
    expect(run(['--resume', 'session-a1', 'keep', 'going']).values)
      .toMatchObject({ task: 'keep going', resume: 'session-a1', interactive: false })
  })

  it('opens the startup selector only as an interactive entry', () => {
    expect(run(['--resume-select']).values).toMatchObject({
      task: '', resumeSelect: true, interactive: true,
    })
    expect(run(['--resume-select', '--resume']).exit).toHaveBeenCalledWith(1)
    expect(run(['--resume-select', 'task']).exit).toHaveBeenCalledWith(1)
  })

  it('carries permission, model, and diagnostic-log selections', () => {
    expect(run(['--permission', 'read-only', '--diagnostic-log', 'out.jsonl', 'audit']).values)
      .toMatchObject({ permission: 'read-only', diagnosticLog: 'out.jsonl' })
    expect(run(['--model', 'deepseek-official/deepseek-v4-pro:high', 'go']).values)
      .toMatchObject({ model: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' } })
  })

  it('rejects invalid values before the terminal is touched', () => {
    expect(run(['--permission', 'yolo', 'go']).exit).toHaveBeenCalledWith(1)
    expect(run(['--model', 'a/b/c', 'go']).exit).toHaveBeenCalledWith(1)
  })

  it('starts an empty interactive session when invoked without arguments', () => {
    expect(run([]).values).toEqual({
      task: '', alternateScreen: false, interactive: true, color: true,
    })
  })
})

describe('startup value parsing', () => {
  it('parses model routes with and without a provider or effort', () => {
    expect(parseModelSelection('deepseek-v4')).toEqual({ model: 'deepseek-v4' })
    expect(parseModelSelection('official/deepseek-v4')).toEqual({
      provider: 'official', model: 'deepseek-v4',
    })
    expect(parseModelSelection('official/deepseek-v4:low')).toEqual({
      provider: 'official', model: 'deepseek-v4', reasoningEffort: 'low',
    })
    expect(() => parseModelSelection('  ')).toThrow('must not be empty')
    expect(() => parseModelSelection('a/')).toThrow('empty component')
    expect(() => parseModelSelection('a:')).toThrow('empty reasoning effort')
    expect(() => parseModelSelection('a:b:c')).toThrow('more than one reasoning-effort suffix')
  })

  it('accepts only the presets this profile configures', () => {
    expect(parsePermissionPreset(' workspace-write ')).toBe('workspace-write')
    expect(parsePermissionPreset('read-only')).toBe('read-only')
    expect(() => parsePermissionPreset('none')).toThrow('unknown permission preset')
  })

  it('uses an empty task for the primary interactive entry and for resume', () => {
    expect(startupValues([], {
      alternateScreen: false, interactive: false, color: true,
    })).toMatchObject({ task: '', interactive: true })
    expect(startupValues([], {
      alternateScreen: false, interactive: false, color: true, resume: true,
    })).toMatchObject({ task: '', resume: 'latest', interactive: true })
  })
})
