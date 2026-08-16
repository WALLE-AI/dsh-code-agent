/**
 * Component tests against a virtual terminal. They cover the input-routing
 * failure modes the plan calls out: double Enter, paste plus Enter in one
 * batch, and modal keys leaking into the composer.
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInkView } from '../src/app.tsx'
import type { TuiActions, TuiView } from '../src/contracts.ts'
import { TuiStore } from '../src/state.ts'
import { displayWidth } from '../src/terminal-text.ts'

const ESC = String.fromCharCode(0x1b)

function virtualStdout(columns: number, rows: number): NodeJS.WriteStream & { frames: string[] } {
  const stream = new EventEmitter() as unknown as NodeJS.WriteStream & { frames: string[] }
  stream.frames = []
  stream.columns = columns
  stream.rows = rows
  stream.isTTY = true
  stream.write = ((data: string) => {
    stream.frames.push(String(data))
    return true
  }) as NodeJS.WriteStream['write']
  return stream
}

interface VirtualStdin extends NodeJS.ReadStream {
  feed(chunk: string): void
}

/** Ink reads raw input through the `readable` event, not `data`. */
function virtualStdin(): VirtualStdin {
  const queue: string[] = []
  const stream = new EventEmitter() as unknown as VirtualStdin
  stream.isTTY = true
  stream.setRawMode = () => stream
  stream.setEncoding = () => stream
  stream.resume = () => stream
  stream.pause = () => stream
  stream.ref = () => stream
  stream.unref = () => stream
  stream.read = () => queue.shift() ?? null
  stream.feed = (chunk: string) => {
    queue.push(chunk)
    stream.emit('readable')
  }
  return stream
}

const views: TuiView[] = []

function mount(store: TuiStore, actions: Partial<TuiActions> = {}, size = { columns: 80, rows: 24 }) {
  const stdout = virtualStdout(size.columns, size.rows)
  const stdin = virtualStdin()
  const calls: TuiActions = {
    cancel: vi.fn(),
    decideApproval: vi.fn(),
    answerQuestion: vi.fn(),
    submit: vi.fn(),
    toggleFold: vi.fn(),
    openLocation: vi.fn(),
    expandTranscript: vi.fn(),
    listSessions: vi.fn(),
    resumeSession: vi.fn(),
    ...actions,
  }
  const view = createInkView(store, calls, stdin, stdout, stdout, false)
  views.push(view)
  const type = async (data: string): Promise<void> => {
    stdin.feed(data)
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  // Ink emits cursor and erase sequences in their own writes; the newest frame
  // that carries visible text is the current screen.
  const screen = (): string => {
    for (let index = stdout.frames.length - 1; index >= 0; index--) {
      const frame = stdout.frames[index] ?? ''
      if (frame.replace(/\[[0-?]*[ -/]*[@-~]/g, '').trim() !== '') return frame
    }
    return ''
  }
  return { calls, type, screen, stdout }
}

afterEach(() => {
  while (views.length > 0) views.pop()?.unmount()
})

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 60))
}

describe('terminal frame', () => {
  it('renders transcript rows, tool badges, and the status line', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.append({ seq: 1, kind: 'user', text: 'fix the flush race' })
    store.append({ seq: 2, kind: 'tool-call', text: '{}', name: 'bash', callId: 'c1' })
    store.append({ seq: 3, kind: 'tool-result', text: 'done', callId: 'c1' })
    const { screen } = mount(store)
    await settle()
    expect(screen()).toContain('> fix the flush race')
    expect(screen()).toContain('✓ bash')
    expect(screen()).toContain('Enter send')
  })

  it('truncates a wide line to the terminal width', async () => {
    const store = new TuiStore(50)
    store.append({ seq: 1, kind: 'user', text: '修复'.repeat(60) })
    const { screen } = mount(store, {}, { columns: 40, rows: 24 })
    await settle()
    const visible = screen().replace(/\[[0-?]*[ -/]*[@-~]/g, '')
    for (const line of visible.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(40)
    expect(visible).toContain('…')
  })
})

describe('input routing', () => {
  it('submits once per Enter and ignores an empty second Enter', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    const { calls, type } = mount(store)
    await settle()
    await type('ship it')
    await type('\r')
    await type('\r')
    expect(calls.submit).toHaveBeenCalledTimes(1)
    expect(calls.submit).toHaveBeenCalledWith('ship it')
  })

  it('keeps a bracketed paste with newlines in the draft until Enter', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    const { calls, type, screen } = mount(store)
    await settle()
    await type(`${ESC}[200~first line\nsecond line${ESC}[201~`)
    expect(calls.submit).not.toHaveBeenCalled()
    expect(screen()).toContain('first line')
    expect(screen()).toContain('second line')
    await type('\r')
    expect(calls.submit).toHaveBeenCalledWith('first line\nsecond line')
  })

  it('routes approval keys to the modal instead of the composer', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setApproval({ id: 1, toolName: 'bash', reason: 'write outside the workspace' })
    const { calls, type, screen } = mount(store)
    await settle()
    expect(screen()).toContain('Approve bash?')
    await type('y')
    expect(calls.decideApproval).toHaveBeenCalledWith(true)
    expect(calls.submit).not.toHaveBeenCalled()
    await type('n')
    expect(calls.decideApproval).toHaveBeenLastCalledWith(false)
  })

  it('arms cancellation before acting on it', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    const { calls, type, screen } = mount(store)
    await settle()
    await type(String.fromCharCode(3))
    expect(calls.cancel).not.toHaveBeenCalled()
    expect(screen()).toContain('Press again to stop')
    await type(String.fromCharCode(3))
    expect(calls.cancel).toHaveBeenCalledOnce()
  })
})

describe('command palette and folding', () => {
  it('opens with Ctrl+P, filters, and prefills the chosen command', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setCommands([
      { name: 'compact', description: 'Compact context' },
      { name: 'permission', description: 'Switch preset', input: { hint: '<preset>' } },
    ])
    const { type, screen } = mount(store)
    await settle()
    await type(String.fromCharCode(16))
    expect(screen()).toContain('Commands')
    expect(screen()).toContain('/compact')
    await type('perm')
    expect(screen()).toContain('/permission')
    expect(screen()).not.toContain('/compact')
    await type('\r')
    expect(screen()).toContain('> /permission')
  })

  it('opens the session picker with Ctrl+R and resumes the selection', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setSessions([
      { id: 'session-new', createdAt: 2_000, live: false, persisted: true, cwd: '/repo' },
      { id: 'session-old', createdAt: 1_000, live: false, persisted: true, cwd: '/repo' },
    ])
    const { calls, type, screen } = mount(store)
    await settle()
    await type(String.fromCharCode(18))
    expect(calls.listSessions).toHaveBeenCalledOnce()
    expect(screen()).toContain('Resume a session')
    expect(screen()).toContain('session-new')
    await type(String.fromCharCode(27) + '[B')
    await type('\r')
    expect(calls.resumeSession).toHaveBeenCalledWith('session-old')
  })

  it('moves focus between the composer and the transcript with Tab', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    for (let seq = 0; seq < 30; seq++) {
      store.append({ seq, kind: 'user', text: `line-${String(seq)}` })
    }
    // Below 16 rows the compact status line hides the focus hint asserted here.
    const { calls, type, screen } = mount(store, {}, { columns: 80, rows: 24 })
    await settle()
    await type('\t')
    expect(screen()).toContain('transcript: j/k scroll')
    // Navigation keys must not leak into the draft while the transcript has focus.
    await type('k')
    await type('j')
    expect(screen()).not.toContain('> kj')
    await type('\r')
    expect(calls.submit).not.toHaveBeenCalled()
    expect(screen()).toContain('Tab transcript')
    await type('hello')
    expect(screen()).toContain('> hello')
  })

  it('pages older history in when PgUp reaches the oldest rendered row', async () => {
    const store = new TuiStore(2, {}, 20)
    for (let seq = 0; seq < 10; seq++) {
      store.append({ seq, kind: 'user', text: `line-${String(seq)}` })
    }
    const { calls, type } = mount(store, {}, { columns: 80, rows: 8 })
    await settle()
    // The first PgUp scrolls inside the window; the next one hits the top.
    await type(String.fromCharCode(27) + '[5~')
    await type(String.fromCharCode(27) + '[5~')
    expect(calls.expandTranscript).toHaveBeenCalled()
  })

  it('folds the tool card in view with Ctrl+O', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.append({ seq: 1, kind: 'tool-call', text: '{}', name: 'bash', callId: 'c1' })
    store.append({
      seq: 2,
      kind: 'tool-result',
      text: Array.from({ length: 20 }, (_, index) => `row-${String(index)}`).join('\n'),
      callId: 'c1',
    })
    const { calls, type, screen } = mount(store)
    await settle()
    expect(screen()).toContain('hidden line(s), Ctrl+O to expand')
    await type(String.fromCharCode(15))
    expect(calls.toggleFold).toHaveBeenCalledWith('tool:c1')
  })
})
