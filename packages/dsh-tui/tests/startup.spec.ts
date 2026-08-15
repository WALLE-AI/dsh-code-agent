import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/startup.ts'
import type { HarnessContext } from '../src/harness-adapter.ts'

function run(args: readonly string[]): unknown {
  const values = new Map<string, unknown>([
    ['cmdlineArgs', { get: () => args }],
    ['appExit', vi.fn()],
  ])
  const ctx: HarnessContext = {
    get: name => values.get(name),
    provide: (name, value) => { values.set(name, value) },
  }
  apply(ctx)
  return values.get('tuiStartup')
}

describe('TUI startup options', () => {
  it('enables semantic colors by default', () => {
    expect(run(['review', 'this'])).toEqual({
      task: 'review this', alternateScreen: false, interactive: false, color: true,
    })
  })

  it('maps interactive, alternate-screen, and no-color independently', () => {
    expect(run(['--interactive', '--alternate-screen', '--no-color', 'ship'])).toEqual({
      task: 'ship', alternateScreen: true, interactive: true, color: false,
    })
  })
})
