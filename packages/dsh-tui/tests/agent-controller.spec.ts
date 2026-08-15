import { describe, expect, it, vi } from 'vitest'
import {
  AgentController,
  type AgentControllerPort,
  type ControlledAgentHandle,
} from '../src/agent-controller.ts'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

function fixtureHandle(id = 'session-1'): ControlledAgentHandle {
  return {
    status: 'idle',
    session: {
      id,
      seq: 2,
      events: [],
      registeredProjections: { asOfSeq: 1, values: {} },
    },
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
    whenIdle: vi.fn(async () => {}),
    flush: vi.fn(async () => true),
    listCommands: vi.fn(() => []),
    executeCommand: vi.fn(async () => undefined),
    presentTool: vi.fn(node => ({ call: { card: 'generic', title: node.name } })),
    dispose: vi.fn(async () => {}),
  }
}

function port(create: () => Promise<ControlledAgentHandle>, resume = create): AgentControllerPort {
  return { create: vi.fn(create), resume: vi.fn(resume) }
}

describe('AgentController', () => {
  it('drives an active created agent and disposes its owned handle once', async () => {
    const handle = fixtureHandle()
    const adapter = port(async () => handle)
    const controller = new AgentController(adapter)

    await expect(controller.create('session-1')).resolves.toBe('session-1')
    controller.followup('next')
    controller.steer('now')
    controller.cancel({ kind: 'hook', reason: 'test' })
    await controller.whenIdle()
    await expect(controller.flush()).resolves.toBe(true)
    expect(controller.listCommands()).toEqual([])
    await expect(controller.executeCommand('/help', new AbortController().signal)).resolves.toBeUndefined()
    expect(controller.presentTool({
      id: 'tool:1', kind: 'tool', callId: '1', name: 'read', input: '{}', output: '',
      status: 'pending', firstSeq: 1, lastSeq: 1,
    })).toEqual({ call: { card: 'generic', title: 'read' } })
    expect(handle.followup).toHaveBeenCalledWith('next')
    expect(handle.steer).toHaveBeenCalledWith('now')
    expect(handle.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'test' })

    await Promise.all([controller.dispose(), controller.dispose()])
    expect(handle.dispose).toHaveBeenCalledOnce()
    expect(controller.state).toBe('disposed')
  })

  it('resumes the requested persisted session', async () => {
    const handle = fixtureHandle('persisted')
    const adapter = port(async () => fixtureHandle('new'), async () => handle)
    const controller = new AgentController(adapter)

    await expect(controller.resume('persisted')).resolves.toBe('persisted')
    expect(adapter.resume).toHaveBeenCalledWith('persisted')
    expect(controller.session).toEqual(handle.session)
    await controller.dispose()
  })

  it('disposes a handle that resolves while attachment is being torn down', async () => {
    const pending = deferred<ControlledAgentHandle>()
    const handle = fixtureHandle('late')
    const controller = new AgentController(port(() => pending.promise))
    const creating = controller.create('late')
    const disposing = controller.dispose()
    pending.resolve(handle)

    await expect(creating).rejects.toThrow('disposed while create was attaching')
    await disposing
    expect(handle.dispose).toHaveBeenCalledOnce()
    expect(controller.state).toBe('disposed')
  })

  it('returns to empty after attachment failure and rejects inactive operations', async () => {
    const handle = fixtureHandle('retry')
    const adapter = port(
      async () => { throw new Error('create failed') },
      async () => handle,
    )
    const controller = new AgentController(adapter)

    await expect(controller.create('broken')).rejects.toThrow('create failed')
    expect(controller.state).toBe('empty')
    expect(() => controller.followup('too soon')).toThrow('while AgentController is empty')
    await expect(controller.resume('retry')).resolves.toBe('retry')
    await controller.dispose()
  })

  it('returns to empty when a malformed port throws synchronously', async () => {
    const controller = new AgentController(port(() => { throw new Error('sync failure') }))
    await expect(controller.create('broken')).rejects.toThrow('sync failure')
    expect(controller.state).toBe('empty')
  })

  it('propagates owned handle teardown failures', async () => {
    const handle = fixtureHandle('failing-dispose')
    handle.dispose = vi.fn(async () => { throw new Error('dispose failed') })
    const controller = new AgentController(port(async () => handle))

    await controller.create('failing-dispose')
    await expect(controller.dispose()).rejects.toThrow('dispose failed')
    await expect(controller.dispose()).rejects.toThrow('dispose failed')
    expect(handle.dispose).toHaveBeenCalledOnce()
  })
})
