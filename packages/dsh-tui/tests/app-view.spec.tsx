/**
 * Component tests against a virtual terminal. They cover the input-routing
 * failure modes the plan calls out: double Enter, paste plus Enter in one
 * batch, and modal keys leaking into the composer.
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createInkView } from '../src/app.tsx'
import type { TuiActions, TuiView } from '../src/contracts.ts'
import { UNICODE_GLYPHS } from '../src/glyphs.ts'
import { buildSplash } from '../src/splash.ts'
import { TuiStore } from '../src/state.ts'
import { resolveTheme } from '../src/theme.ts'
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

function mount(
  store: TuiStore,
  actions: Partial<TuiActions> = {},
  size = { columns: 80, rows: 24 },
  clock: () => number = Date.now,
) {
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
    listFiles: vi.fn(),
    resumeSession: vi.fn(),
    ...actions,
  }
  // No colour: assertions read the plain text the terminal would show.
  const view = createInkView(
    store, calls, stdin, stdout, stdout, resolveTheme('none'), undefined, true, clock,
  )
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
    expect(screen()).toContain('tools 1')
    expect(screen()).toContain('ctrl+p commands')
  })

  it('marks each speaker and hangs a tool body under its gutter', async () => {
    const store = new TuiStore(50)
    store.append({ seq: 1, kind: 'user', text: 'fix the flush race' })
    store.append({ seq: 2, kind: 'assistant-final', text: 'Looking now.', messageId: 'm1' })
    store.append({ seq: 3, kind: 'tool-call', text: '{}', name: 'bash', callId: 'c1' })
    store.append({ seq: 4, kind: 'tool-result', text: 'first\nsecond', callId: 'c1' })
    const { screen } = mount(store)
    await settle()
    expect(screen()).toContain('> fix the flush race')
    expect(screen()).toContain('● Looking now.')
    // The card's first body row carries the gutter and the rest align under it,
    // so the whole card reads as one block.
    const visible = screen().replace(/\[[0-?]*[ -/]*[@-~]/g, '')
    expect(visible).toContain(' ⎿ ')
    for (const row of ['first', 'second']) {
      expect(visible.split('\n').some(line => line.startsWith('   ') && line.includes(row)))
        .toBe(true)
    }
  })

  it('folds reasoning behind a named marker', async () => {
    const store = new TuiStore(50)
    store.append({ seq: 1, kind: 'reasoning-delta', text: 'weighing options', messageId: 'r1' })
    const { screen } = mount(store)
    await settle()
    expect(screen()).toContain('∴ Thinking')
    // The content itself is behind the fold, with the way to open it stated.
    expect(screen()).not.toContain('weighing options')
    expect(screen()).toContain('ctrl+o to expand')
  })

  it('greets a fresh session and lets the banner scroll away', async () => {
    const store = new TuiStore(50)
    store.setHeader(width => buildSplash(
      { title: 'DeepSeek Harness TUI', directory: 'repo', tips: ['/help for commands'] },
      width,
      UNICODE_GLYPHS,
    ))
    const { screen } = mount(store)
    await settle()
    expect(screen()).toContain('DeepSeek Harness TUI')
    expect(screen()).toContain('Tip: /help for commands')
  })

  it('wraps a wide line instead of cutting it off', async () => {
    const store = new TuiStore(50)
    store.append({ seq: 1, kind: 'user', text: '修复'.repeat(60) })
    const { screen } = mount(store, {}, { columns: 40, rows: 24 })
    await settle()
    const visible = screen().replace(/\[[0-?]*[ -/]*[@-~]/g, '')
    for (const line of visible.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(40)
    // The text continues onto further rows rather than ending in an ellipsis.
    expect(visible.split('\n').filter(line => line.includes('修复')).length).toBeGreaterThan(1)
    expect(visible).not.toContain('…')
  })
})

describe('running feedback', () => {
  it('animates a pending tool card and shows how long it has run', async () => {
    let now = 1_000_000
    const clock = (): number => now
    const store = new TuiStore(50, {}, undefined, clock)
    store.setInteractive(true)
    store.setStatus('running')
    store.append({ seq: 1, kind: 'tool-call', text: '{}', name: 'bash', callId: 'c1' })
    now += 12_000
    const { screen } = mount(store, {}, { columns: 80, rows: 24 }, clock)
    await settle()
    const first = screen()
    // The static glyph is replaced by a frame, and the elapsed field appears.
    expect(first).toContain('bash')
    expect(first).toContain('12s')
    expect(first).not.toContain('▸ bash')
    // A settled call loses both, and so does the working line once idle.
    store.append({ seq: 2, kind: 'tool-result', text: 'done', callId: 'c1' })
    store.setStatus('idle')
    await settle()
    expect(screen()).toContain('✓ bash')
    expect(screen()).not.toContain('12s')
  })

  it('says the run is alive, and stops saying it once idle', async () => {
    let now = 1_000_000
    const clock = (): number => now
    const store = new TuiStore(50, {}, undefined, clock)
    store.setInteractive(true)
    store.setModel('deepseek/chat')
    store.append({ seq: 1, kind: 'user', text: 'go' })
    store.setStatus('running')
    now += 7_000
    const { screen } = mount(store, {}, { columns: 80, rows: 24 }, clock)
    await settle()
    expect(screen()).toMatch(/(Working|Thinking|Digging|Reasoning|Puzzling)…/)
    expect(screen()).toContain('7s')
    // The resolved model reaches the status row.
    expect(screen()).toContain('deepseek/chat')

    store.setStatus('idle')
    await settle()
    expect(screen()).not.toMatch(/Working…/)
  })

  it('stops repainting once nothing is running', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setStatus('running')
    store.append({ seq: 1, kind: 'tool-call', text: '{}', name: 'bash', callId: 'c1' })
    const { stdout } = mount(store)
    await settle()
    // While a call is open the clock drives frames on its own.
    const whileRunning = stdout.frames.length
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(stdout.frames.length).toBeGreaterThan(whileRunning)

    store.append({ seq: 2, kind: 'tool-result', text: 'done', callId: 'c1' })
    store.setStatus('idle')
    await settle()
    // Settled, the frame must be quiet: an idle TUI holds no interval at all.
    const whenIdle = stdout.frames.length
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(stdout.frames.length).toBe(whenIdle)
  })

  it('renders the goal and the active todo the projection already reported', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setRegisteredProjections({
      asOfSeq: 1,
      values: {
        goal: { text: 'fix the flush race' },
        todos: [
          { content: 'reproduce the race', status: 'in_progress' },
          { content: 'write the fix', status: 'pending' },
          { content: 'read the code', status: 'completed' },
        ],
      },
    })
    const { screen } = mount(store)
    await settle()
    expect(screen()).toContain('fix the flush race')
    expect(screen()).toContain('reproduce the race')
    expect(screen()).toContain('(1/3)')
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

  it('edits the draft at the caret instead of only at the end', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    const { calls, type, screen } = mount(store)
    await settle()
    await type('one two')
    // Ctrl+A to the line start, insert, then Ctrl+E back to the end.
    await type(String.fromCharCode(1))
    await type('zero ')
    expect(screen()).toContain('zero one two')
    await type(String.fromCharCode(5))
    // Ctrl+W kills the word before the caret.
    await type(String.fromCharCode(23))
    await type('\r')
    expect(calls.submit).toHaveBeenCalledWith('zero one ')
  })

  it('clears a non-empty draft on the first Esc instead of arming a cancel', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    const { calls, type, screen } = mount(store)
    await settle()
    await type('draft text')
    await type(ESC)
    expect(screen()).not.toContain('draft text')
    expect(screen()).not.toContain('Press again to stop')
    // With nothing left to clear, Esc falls through to the two-step cancel.
    await type(ESC)
    expect(calls.cancel).not.toHaveBeenCalled()
    expect(screen()).toContain('Press again to stop')
    await type(ESC)
    expect(calls.cancel).toHaveBeenCalledOnce()
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

  it('completes a slash command with Tab without leaving the composer', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setCommands([
      { name: 'compact', description: 'Compact context' },
      { name: 'permission', description: 'Switch preset', input: { hint: '<preset>' } },
    ])
    const { calls, type, screen } = mount(store)
    await settle()
    await type('/perm')
    expect(screen()).toContain('/permission')
    await type('\t')
    // Tab accepted the candidate instead of moving focus to the transcript.
    expect(screen()).toContain('> /permission')
    expect(screen()).not.toContain('transcript: j/k scroll')
    await type('read-only')
    await type('\r')
    expect(calls.submit).toHaveBeenCalledWith('/permission read-only')
  })

  it('completes an @ mention mid-message and asks for the matching paths', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setFiles([
      { path: 'src/app.tsx', directory: false },
      { path: 'src/ink', directory: true },
    ])
    const { calls, type, screen } = mount(store)
    await settle()
    await type('look at @src/a')
    expect(calls.listFiles).toHaveBeenCalledWith('src/a')
    expect(screen()).toContain('src/app.tsx')
    await type('\t')
    await type('please')
    await type('\r')
    expect(calls.submit).toHaveBeenCalledWith('look at @src/app.tsx please')
  })

  it('dismisses the completion list with Esc without clearing the draft', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setCommands([{ name: 'compact', description: 'Compact context' }])
    const { type, screen } = mount(store)
    await settle()
    await type('/comp')
    expect(screen()).toContain('Compact context')
    await type(ESC)
    expect(screen()).not.toContain('Compact context')
    expect(screen()).toContain('> /comp')
  })

  it('shows the call itself in the approval panel, and answers with the arrows', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.append({ seq: 1, kind: 'tool-call', text: '{}', name: 'bash', callId: 'c1' })
    store.setApproval({
      id: 1, toolName: 'bash', callId: 'c1', reason: 'write outside the workspace',
    })
    const { calls, type, screen } = mount(store)
    await settle()
    expect(screen()).toContain('Approve bash?')
    expect(screen()).toContain('allow once')
    expect(screen()).toContain('reject')
    expect(screen()).toContain('write outside the workspace')
    // Reject is highlighted by default, so a bare Enter fails closed.
    await type('\r')
    expect(calls.decideApproval).toHaveBeenLastCalledWith(false)
  })

  it('allows once when the arrow selection is moved up first', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setApproval({ id: 1, toolName: 'bash' })
    const { calls, type } = mount(store)
    await settle()
    await type(String.fromCharCode(27) + '[A')
    await type('\r')
    expect(calls.decideApproval).toHaveBeenLastCalledWith(true)
  })

  it('opens the shortcut sheet with ? and closes it on the next key', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    const { type, screen } = mount(store)
    await settle()
    await type('?')
    expect(screen()).toContain('Shortcuts')
    expect(screen()).toContain('Ctrl+W')
    await type('x')
    expect(screen()).not.toContain('Shortcuts')
    // The key that closed the sheet is consumed, not typed into the draft.
    expect(screen()).not.toContain('> x')
  })

  it('treats ? as ordinary text once the draft is non-empty', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    const { calls, type, screen } = mount(store)
    await settle()
    await type('why')
    await type('?')
    expect(screen()).not.toContain('Shortcuts')
    await type('\r')
    expect(calls.submit).toHaveBeenCalledWith('why?')
  })

  it('cycles the permission preset with Shift+Tab through the official command', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setRegisteredProjections({
      asOfSeq: 1,
      values: {
        permissions: {
          currentValue: 'workspace-write',
          options: [
            { value: 'read-only', name: 'read only' },
            { value: 'workspace-write', name: 'workspace write' },
            { value: 'danger-full-access', name: 'full access' },
          ],
        },
      },
    })
    const { calls, type } = mount(store)
    await settle()
    await type(String.fromCharCode(27) + '[Z')
    expect(calls.submit).toHaveBeenCalledWith('/permission danger-full-access')
  })

  it('opens the session browser with Ctrl+R and resumes the row under the cursor', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setSessions([
      { id: 'session-new', createdAt: 2_000, live: false, persisted: true, cwd: '/repo/alpha' },
      { id: 'session-old', createdAt: 1_000, live: false, persisted: true, cwd: '/repo/beta' },
    ])
    const { calls, type, screen } = mount(store)
    await settle()
    await type(String.fromCharCode(18))
    expect(calls.listSessions).toHaveBeenCalledOnce()
    // The browser is a screen: it replaces the conversation rather than
    // floating over it, so the composer is gone while it is open.
    expect(screen()).toContain('Sessions')
    expect(screen()).toContain('session-new')
    expect(screen()).not.toContain('ctrl+p commands')
    await type(String.fromCharCode(27) + '[B')
    await type('\r')
    expect(calls.resumeSession).toHaveBeenCalledWith('session-old')
  })

  it('filters the browser as you type and peels one layer per Esc', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setSessions([
      { id: 'session-new', createdAt: 2_000, live: false, persisted: true, cwd: '/repo/alpha' },
      { id: 'session-old', createdAt: 1_000, live: false, persisted: true, cwd: '/repo/beta' },
    ])
    const { type, screen } = mount(store)
    await settle()
    await type(String.fromCharCode(18))
    await type('old')
    expect(screen()).toContain('session-old')
    expect(screen()).not.toContain('session-new')
    // The first Esc clears the filter; the second closes the screen.
    await type(ESC)
    expect(screen()).toContain('session-new')
    await type(ESC)
    expect(screen()).toContain('ctrl+p commands')
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
    expect(screen()).toContain('j/k scroll')
    // Navigation keys must not leak into the draft while the transcript has focus.
    await type('k')
    await type('j')
    expect(screen()).not.toContain('> kj')
    await type('\r')
    expect(calls.submit).not.toHaveBeenCalled()
    expect(screen()).toContain('ctrl+p commands')
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
    expect(screen()).toContain('lines (ctrl+o to expand)')
    await type(String.fromCharCode(15))
    expect(calls.toggleFold).toHaveBeenCalledWith('tool:c1')
  })
})
