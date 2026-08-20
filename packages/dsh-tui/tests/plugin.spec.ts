/**
 * Composition-level tests for the TUI plugin: the exit-code contract, the
 * bounded shutdown triggers (cancel, signal, stdin EOF), and the in-process
 * session loop. The renderer is replaced, but the plugin, store, queues,
 * controller and adapter are the real ones.
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiActions } from '../src/contracts.ts'
import { NOT_DURABLE_EXIT_CODE } from '../src/harness-adapter.ts'
import { apply, internals, type Config } from '../src/plugin.ts'
import type { TuiStore } from '../src/state.ts'
import { fakeHarness, type FakeHarnessOptions } from './support/fake-harness.ts'

const realInternals = { ...internals }

function fakeStream(isTTY: boolean): NodeJS.ReadStream & NodeJS.WriteStream {
  const stream = new EventEmitter() as unknown as NodeJS.ReadStream & NodeJS.WriteStream
  stream.isTTY = isTTY
  stream.columns = 100
  stream.rows = 30
  stream.write = (() => true) as NodeJS.WriteStream['write']
  return stream
}

interface Mounted {
  readonly exitCode: Promise<number>
  readonly harness: ReturnType<typeof fakeHarness>
  readonly stdin: NodeJS.ReadStream & NodeJS.WriteStream
  readonly stderr: string[]
  readonly stdout: string[]
  /** Resolves once the view is created, exposing the live store and actions. */
  readonly view: Promise<{ store: TuiStore; actions: TuiActions }>
  unmounted(): boolean
}

function mountPlugin(
  config: Partial<Config> & { task: string },
  options: FakeHarnessOptions = {},
  tty = true,
): Mounted {
  const harness = fakeHarness(options)
  const stdin = fakeStream(tty)
  const stdout = fakeStream(tty)
  const stdoutWrites: string[] = []
  stdout.write = ((text: string) => {
    stdoutWrites.push(String(text))
    return true
  }) as NodeJS.WriteStream['write']
  const stderr: string[] = []
  const errorStream = fakeStream(false)
  errorStream.write = ((text: string) => {
    stderr.push(String(text))
    return true
  }) as NodeJS.WriteStream['write']

  let unmount = false
  let publishView: (value: { store: TuiStore; actions: TuiActions }) => void = () => {}
  const view = new Promise<{ store: TuiStore; actions: TuiActions }>((resolve) => {
    publishView = resolve
  })
  internals.stdin = stdin
  internals.stdout = stdout
  internals.stderr = errorStream
  internals.createView = (store, actions) => {
    publishView({ store, actions })
    return { unmount: () => { unmount = true } }
  }

  let settle: (code: number) => void = () => {}
  const exitCode = new Promise<number>((resolve) => { settle = resolve })
  harness.ctx.provide('appExit', (code: number) => { settle(code) })
  apply(harness.ctx, { interactive: false, ...config })
  return { exitCode, harness, stdin, stderr, stdout: stdoutWrites, view, unmounted: () => unmount }
}

/** The controller is attached after the view mounts; input is refused before that. */
async function interactiveSession(mounted: Mounted): Promise<{ store: TuiStore; actions: TuiActions }> {
  const view = await mounted.view
  await vi.waitFor(() => { expect(view.store.snapshot().interactive).toBe(true) })
  return view
}

afterEach(() => {
  Object.assign(internals, realInternals)
  vi.restoreAllMocks()
})

describe('startup refusals', () => {
  it('refuses a redirected terminal and exits non-zero', async () => {
    const mounted = mountPlugin({ task: 'go' }, {}, false)
    expect(await mounted.exitCode).toBe(1)
    expect(mounted.stderr.join('')).toContain('headless')
    expect(mounted.harness.create).not.toHaveBeenCalled()
  })

  it('refuses an empty task when no session is being resumed', async () => {
    const mounted = mountPlugin({ task: '   ' })
    expect(await mounted.exitCode).toBe(1)
    expect(mounted.stderr.join('')).toContain('task must not be empty')
  })
})

describe('exit-code contract', () => {
  it('completes a one-shot task, flushes, disposes, and exits zero', async () => {
    const mounted = mountPlugin({ task: 'do it' })
    expect(await mounted.exitCode).toBe(0)
    expect(mounted.harness.flush).toHaveBeenCalled()
    expect(mounted.harness.dispose).toHaveBeenCalledOnce()
    expect(mounted.unmounted()).toBe(true)
  })

  it('reports a non-durable session with the dedicated code', async () => {
    let calls = 0
    const mounted = mountPlugin({ task: 'do it' }, {
      flush: async () => {
        calls++
        return calls === 1
      },
    })
    expect(await mounted.exitCode).toBe(NOT_DURABLE_EXIT_CODE)
    expect(mounted.harness.dispose).toHaveBeenCalledOnce()
  })

  it('fails when the turn ends for a non-completion reason', async () => {
    const mounted = mountPlugin({ task: 'do it' }, { turnReason: 'error' })
    expect(await mounted.exitCode).toBe(1)
  })
})

describe('bounded shutdown triggers', () => {
  it('exits 130 when the user cancels an interactive session', async () => {
    const mounted = mountPlugin({ task: 'do it', interactive: true })
    const { actions } = await mounted.view
    actions.cancel()
    expect(await mounted.exitCode).toBe(130)
    expect(mounted.harness.dispose).toHaveBeenCalledOnce()
    expect(mounted.unmounted()).toBe(true)
  })

  it('exits 130 on SIGTERM', async () => {
    const mounted = mountPlugin({ task: 'do it', interactive: true })
    await mounted.view
    process.emit('SIGTERM')
    expect(await mounted.exitCode).toBe(130)
    expect(mounted.harness.dispose).toHaveBeenCalledOnce()
  })

  it('shuts down when stdin reaches end of file', async () => {
    const mounted = mountPlugin({ task: 'do it', interactive: true })
    await mounted.view
    mounted.stdin.emit('end')
    expect(await mounted.exitCode).toBe(0)
    expect(mounted.harness.dispose).toHaveBeenCalledOnce()
    expect(mounted.unmounted()).toBe(true)
  })

  it('removes its signal and stdin listeners on exit', async () => {
    const before = process.listenerCount('SIGTERM')
    const mounted = mountPlugin({ task: 'do it', interactive: true })
    const { actions } = await mounted.view
    actions.cancel()
    await mounted.exitCode
    expect(process.listenerCount('SIGTERM')).toBe(before)
    expect(mounted.stdin.listenerCount('end')).toBe(0)
  })
})

describe('interactive session loop', () => {
  it('prints an exact resume command after a durable /quit', async () => {
    const mounted = mountPlugin({ task: '', interactive: true })
    const { actions } = await interactiveSession(mounted)
    actions.submit('/quit')
    expect(await mounted.exitCode).toBe(0)
    expect(mounted.stdout.join('')).toContain('Session saved: fake-session')
    expect(mounted.stdout.join('')).toContain('Resume: dshcodecli --resume fake-session')
  })

  it('does not print a saved receipt when final persistence fails', async () => {
    let calls = 0
    const mounted = mountPlugin({ task: '', interactive: true }, {
      flush: async () => ++calls === 1,
    })
    const { actions } = await interactiveSession(mounted)
    actions.submit('/quit')
    expect(await mounted.exitCode).toBe(NOT_DURABLE_EXIT_CODE)
    expect(mounted.stdout.join('')).not.toContain('Session saved:')
  })

  it('starts without a synthetic first task and waits for the composer', async () => {
    const mounted = mountPlugin({ task: '', interactive: true })
    const { actions, store } = await interactiveSession(mounted)
    expect(store.snapshot().nodes).toEqual([])
    actions.cancel()
    await mounted.exitCode
  })

  it('attaches a second session for /new and still exits cleanly', async () => {
    const mounted = mountPlugin({ task: 'do it', interactive: true })
    const { actions, store } = await interactiveSession(mounted)
    actions.submit('/new')
    await vi.waitFor(() => { expect(mounted.harness.create).toHaveBeenCalledTimes(2) })
    expect(store.snapshot().notice).toBe('started a new session')
    actions.cancel()
    await mounted.exitCode
    expect(mounted.harness.dispose).toHaveBeenCalledTimes(2)
  })

  it('resumes the picked session through the session query service', async () => {
    const mounted = mountPlugin({ task: 'do it', interactive: true })
    const { actions } = await interactiveSession(mounted)
    actions.listSessions()
    await vi.waitFor(() => { expect(mounted.harness.listSessions).toHaveBeenCalled() })
    actions.resumeSession('session-newer')
    await vi.waitFor(() => { expect(mounted.harness.resume).toHaveBeenCalledOnce() })
    actions.cancel()
    await mounted.exitCode
  })

  it('requires a second send before entering the unrestricted preset', async () => {
    const mounted = mountPlugin({ task: 'do it', interactive: true })
    const { actions, store } = await interactiveSession(mounted)
    actions.submit('/permission danger-full-access')
    await vi.waitFor(() => {
      expect(store.snapshot().notice).toContain('send the same command again')
    })
    expect(mounted.harness.execute).not.toHaveBeenCalled()
    actions.submit('/permission danger-full-access')
    await vi.waitFor(() => { expect(mounted.harness.execute).toHaveBeenCalledOnce() })
    actions.cancel()
    await mounted.exitCode
  })

  it('steers a running Agent instead of queueing a follow-up', async () => {
    const mounted = mountPlugin({ task: 'do it', interactive: true }, { status: 'running' })
    const { actions, store } = await interactiveSession(mounted)
    actions.submit('also check the logs')
    await vi.waitFor(() => {
      expect(store.snapshot().notice).toBe('queued for the current step')
    })
    expect(mounted.harness.agent.steer).toHaveBeenCalledOnce()
    expect(mounted.harness.agent.followup).toHaveBeenCalledTimes(1) // the initial task only
    actions.cancel()
    await mounted.exitCode
  })
})
