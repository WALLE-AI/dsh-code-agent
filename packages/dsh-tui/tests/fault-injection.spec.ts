/**
 * Fault-injection matrix. Every failure mode must stay observable and fail
 * closed: no silent approval, no lost durability signal, no hung interaction.
 */

import { describe, expect, it } from 'vitest'
import { ApprovalQueue } from '../src/approval-queue.ts'
import { QuestionQueue } from '../src/question-queue.ts'
import { executeHarnessTask, NOT_DURABLE_EXIT_CODE } from '../src/harness-adapter.ts'
import { ShutdownCoordinator } from '../src/shutdown.ts'
import { TuiStore } from '../src/state.ts'
import { fakeHarness, fakeHooks } from './support/fake-harness.ts'

describe('approval faults fail closed', () => {
  it('never allows when the answerer is torn down, aborted, or absent', async () => {
    const store = new TuiStore(10)
    const queue = new ApprovalQueue(store)
    const aborted = new AbortController()
    aborted.abort()
    await expect(queue.ask({ toolName: 'bash' }, aborted.signal)).resolves.toBe('cancelled')

    const pending = queue.ask({ toolName: 'bash' })
    queue.close()
    await expect(pending).resolves.toBe('unavailable')
    expect(store.snapshot().approval).toBeUndefined()
  })

  it('settles every queued interaction when the session shuts down', async () => {
    const store = new TuiStore(10)
    const approvals = new ApprovalQueue(store)
    const questions = new QuestionQueue(store)
    const first = approvals.ask({ toolName: 'bash' })
    const second = approvals.ask({ toolName: 'write' })
    const question = questions.ask([{ id: 'a', question: 'A?' }])
    const coordinator = new ShutdownCoordinator({
      stopInput: () => {},
      settleInteractions: () => {
        approvals.close()
        questions.close()
      },
      cancel: () => {},
      whenIdle: async () => {},
      finish: () => {},
    }, { graceMs: 10 })
    await coordinator.request('signal')
    await expect(first).resolves.toBe('unavailable')
    await expect(second).resolves.toBe('unavailable')
    await expect(question).rejects.toThrow('unavailable')
  })
})

describe('durability and command faults', () => {
  it('reports a non-durable exit code when the final flush finds no listener', async () => {
    let calls = 0
    const fake = fakeHarness({
      flush: async () => {
        calls++
        // The task-path flush succeeds; the teardown flush finds no listener.
        return calls === 1
      },
    })
    const observed = fakeHooks()
    const code = await executeHarnessTask(fake.ctx, { task: 'do it' }, observed)
    expect(code).toBe(NOT_DURABLE_EXIT_CODE)
    expect(observed.diagnostic).toHaveBeenCalledWith(expect.stringContaining('not flushed'))
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it('surfaces a throwing flush and still disposes the handle', async () => {
    const fake = fakeHarness({ flush: async () => { throw new Error('disk offline') } })
    const observed = fakeHooks()
    await expect(executeHarnessTask(fake.ctx, { task: 'do it' }, observed)).rejects.toThrow('disk offline')
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it('fails the run when a turn ends for any reason other than completion', async () => {
    const fake = fakeHarness({ turnReason: 'error' })
    expect(await executeHarnessTask(fake.ctx, { task: 'do it' }, fakeHooks())).toBe(1)
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it('refuses to start when the requested permission preset is rejected or unknown', async () => {
    for (const commandResult of ['error', 'missing'] as const) {
      const fake = fakeHarness({ commandResult })
      await expect(executeHarnessTask(fake.ctx, {
        task: 'do it', permissionPreset: 'read-only',
      }, fakeHooks())).rejects.toThrow('permission preset read-only was rejected')
      expect(fake.dispose).toHaveBeenCalledOnce()
    }
  })

  it('fails loudly when a required Harness service is missing', async () => {
    const fake = fakeHarness()
    fake.ctx.provide('sessionProjections', undefined)
    await expect(executeHarnessTask(fake.ctx, { task: 'do it' }, fakeHooks()))
      .rejects.toThrow('Harness services did not settle')
  })
})
