/**
 * The notice queue.
 *
 * Time is a parameter here, so every rule is asserted at an exact instant
 * rather than waited for. The two cases the queue exists to fix are the first
 * two tests: nothing is silently overwritten, and nothing stays for ever.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_NOTICE_MS, dropNotice, emptyNoticeQueue, pushNotice, textNotice,
  tickNotices, type Notice,
} from '../src/notifications.ts'
import { TuiStore } from '../src/state.ts'

const ambient = (key: string, text: string): Notice =>
  ({ key, text, priority: 'low' })
const answer = (text: string): Notice =>
  ({ key: 'action', text, priority: 'immediate' })

describe('the row is never silently overwritten', () => {
  it('queues the second notice instead of losing it', () => {
    let queue = pushNotice(emptyNoticeQueue, ambient('a', 'tmux detected'), 0)
    queue = pushNotice(queue, textNotice('resumed session s1'), 0)
    // The row is not stolen mid-display: only an answer to the action in
    // progress does that. The second notice waits, and is not lost — which is
    // the whole failure this replaces, where it overwrote the first.
    expect(queue.current?.text).toBe('tmux detected')
    expect(queue.queue.map(notice => notice.text)).toEqual(['resumed session s1'])
    expect(tickNotices(queue, DEFAULT_NOTICE_MS).current?.text).toBe('resumed session s1')
  })

  it('gives the row back to what an answer displaced', () => {
    let queue = pushNotice(emptyNoticeQueue, ambient('a', 'no colour'), 0)
    expect(queue.current?.text).toBe('no colour')
    queue = pushNotice(queue, answer('Commands: /help'), 100)
    expect(queue.current?.text).toBe('Commands: /help')
    expect(queue.queue.map(notice => notice.text)).toEqual(['no colour'])
    expect(tickNotices(queue, 100 + DEFAULT_NOTICE_MS).current?.text).toBe('no colour')
  })

  it('replaces an answer with the answer to the next action', () => {
    let queue = pushNotice(emptyNoticeQueue, answer('Commands: /help'), 0)
    queue = pushNotice(queue, answer('mouse wheel released'), 10)
    expect(queue.current?.text).toBe('mouse wheel released')
    // A superseded answer must never resurface: its question is gone.
    expect(queue.queue).toHaveLength(0)
  })
})

describe('everything expires', () => {
  it('holds the row for its own timeout and then yields it', () => {
    const queue = pushNotice(emptyNoticeQueue, { ...ambient('a', 'slow'), timeoutMs: 500 }, 0)
    expect(tickNotices(queue, 499).current?.text).toBe('slow')
    expect(tickNotices(queue, 500).current).toBeUndefined()
  })

  it('settles to nothing once the queue drains', () => {
    let queue = pushNotice(emptyNoticeQueue, { ...ambient('a', 'one'), timeoutMs: 100 }, 0)
    queue = pushNotice(queue, { ...ambient('b', 'two'), timeoutMs: 100 }, 0)
    queue = tickNotices(queue, 100)
    expect(queue.current?.text).toBe('two')
    queue = tickNotices(queue, 200)
    expect(queue.current).toBeUndefined()
    expect(queue.queue).toHaveLength(0)
  })
})

describe('a key is an identity', () => {
  it('replaces rather than queues', () => {
    let queue = pushNotice(emptyNoticeQueue, ambient('mode', 'plan'), 0)
    queue = pushNotice(queue, ambient('mode', 'workspace-write'), 10)
    expect(queue.current?.text).toBe('workspace-write')
    expect(queue.queue).toHaveLength(0)
  })

  it('folds when the held notice says how', () => {
    // The rule carries itself forward, so a third arrival merges too.
    const count = (held: Notice, incoming: Notice): Notice => ({
      ...incoming,
      text: `${String(Number(held.text.split(' ')[0]) + 1)} files changed`,
      fold: count,
    })
    const counting: Notice = {
      key: 'files',
      text: '1 file changed',
      priority: 'low',
      fold: count,
    }
    let queue = pushNotice(emptyNoticeQueue, counting, 0)
    queue = pushNotice(queue, counting, 1)
    queue = pushNotice(queue, counting, 2)
    expect(queue.current?.text).toBe('3 files changed')
    expect(queue.queue).toHaveLength(0)
  })

  it('folds a notice still waiting in the queue', () => {
    const concat = (a: Notice, b: Notice): Notice => ({ ...b, text: a.text + b.text, fold: concat })
    const held: Notice = { key: 'files', text: 'a', priority: 'low', fold: concat }
    let queue = pushNotice(emptyNoticeQueue, ambient('front', 'holding'), 0)
    queue = pushNotice(queue, held, 0)
    queue = pushNotice(queue, { ...held, text: 'b' }, 0)
    expect(queue.queue.map(notice => notice.text)).toEqual(['ab'])
  })
})

describe('retraction', () => {
  it('drops the keys an event has made untrue, wherever they are', () => {
    let queue = pushNotice(emptyNoticeQueue, ambient('offline', 'no network'), 0)
    queue = pushNotice(queue, ambient('stale', 'index out of date'), 0)
    queue = pushNotice(queue, {
      key: 'online',
      text: 'reconnected',
      priority: 'low',
      invalidates: ['offline', 'stale'],
    }, 0)
    expect(queue.current?.text).toBe('reconnected')
    expect(queue.queue).toHaveLength(0)
  })

  it('drops one key on request and promotes the next', () => {
    let queue = pushNotice(emptyNoticeQueue, ambient('a', 'one'), 0)
    queue = pushNotice(queue, ambient('b', 'two'), 0)
    queue = dropNotice(queue, 'a', 0)
    expect(queue.current?.text).toBe('two')
  })
})

describe('priority ordering', () => {
  it('shows higher priority first and keeps arrival order within one', () => {
    let queue = pushNotice(emptyNoticeQueue, ambient('hold', 'holding the row'), 0)
    queue = pushNotice(queue, ambient('a', 'first low'), 0)
    queue = pushNotice(queue, { key: 'h', text: 'high', priority: 'high' }, 0)
    queue = pushNotice(queue, ambient('b', 'second low'), 0)
    expect(queue.queue.map(notice => notice.text))
      .toEqual(['high', 'first low', 'second low'])
  })
})

describe('the store surface', () => {
  it('reports the showing text, its tone and how many are waiting', () => {
    const store = new TuiStore(10, {}, undefined, () => 0)
    store.pushNotice({ key: 'a', text: 'first', priority: 'low', tone: 'error' })
    store.pushNotice({ key: 'b', text: 'second', priority: 'low' })
    expect(store.snapshot().notice).toBe('first')
    expect(store.snapshot().noticeTone).toBe('error')
    expect(store.snapshot().noticesQueued).toBe(1)
  })

  it('clears the row and everything waiting for it', () => {
    const store = new TuiStore(10, {}, undefined, () => 0)
    store.pushNotice({ key: 'a', text: 'first', priority: 'low' })
    store.pushNotice({ key: 'b', text: 'second', priority: 'low' })
    store.setNotice(undefined)
    expect(store.snapshot().notice).toBeUndefined()
    expect(store.snapshot().noticesQueued).toBe(0)
  })

  it('publishes nothing when a tick changes nothing', () => {
    let now = 0
    const store = new TuiStore(10, {}, undefined, () => now)
    store.pushNotice({ key: 'a', text: 'first', priority: 'low', timeoutMs: 5_000 })
    const listener = vi.fn()
    store.subscribe(listener)
    now = 1_000
    store.tickNotices()
    expect(listener).not.toHaveBeenCalled()
    now = 5_000
    store.tickNotices()
    expect(listener).toHaveBeenCalledOnce()
    expect(store.snapshot().notice).toBeUndefined()
  })
})
