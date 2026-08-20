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
import { DEFAULT_KEYMAP } from '../src/keybindings.ts'
import { emptyBrowser, type BrowserState } from '../src/session-browser.ts'
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

/**
 * A row buffer for the small escape vocabulary the TUI actually emits: cursor
 * up, column reset, erase-line, and text terminated by a newline. Anything else
 * stays in the row text, so assertions can strip styling themselves.
 */
function renderScreen(writes: readonly string[]): string {
  const rows: string[] = []
  let row = 0
  let pending = ''
  let dirty = false
  const flush = (): void => {
    if (dirty) rows[row] = pending
    pending = ''
    dirty = false
  }
  for (const write of writes) {
    let at = 0
    while (at < write.length) {
      const move = /^\u001B\[(\d*)A/.exec(write.slice(at))
      if (move !== null) {
        flush()
        row = Math.max(0, row - (move[1] === '' ? 1 : Number(move[1])))
        at += move[0].length
        continue
      }
      if (write.startsWith(`${ESC}[2K`, at)) {
        rows[row] = ''
        pending = ''
        dirty = false
        at += 4
        continue
      }
      if (write.startsWith(`${ESC}[G`, at)) {
        at += 3
        continue
      }
      if (write[at] === '\n') {
        flush()
        row++
        at++
        continue
      }
      pending += write[at]
      dirty = true
      at++
    }
    flush()
  }
  return rows.join('\n')
}

const views: TuiView[] = []

function mount(
  store: TuiStore,
  actions: Partial<TuiActions> = {},
  size = { columns: 80, rows: 24 },
  clock: () => number = Date.now,
  initialBrowser?: BrowserState,
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
    DEFAULT_KEYMAP, undefined, initialBrowser,
  )
  views.push(view)
  const type = async (data: string): Promise<void> => {
    stdin.feed(data)
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  // Frames are painted differentially (`frame-writer.ts`), so no single write is
  // the screen: the screen is what the rows add up to. This replays the writes
  // into a row buffer the way a terminal would.
  const screen = (): string => renderScreen(stdout.frames)
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

  it('renders assistant markdown, laying a table out on screen', async () => {
    const store = new TuiStore(50)
    store.append({
      seq: 1,
      kind: 'assistant-final',
      messageId: 'm1',
      text: [
        '## 工具',
        '| 工具 | 用途 |',
        '|------|------|',
        '| **read** | 读取文本文件内容 |',
        '| write | 创建新文件 |',
      ].join('\n'),
    })
    const { screen } = mount(store)
    await settle()
    const visible = screen().replace(/\[[0-?]*[ -/]*[@-~]/g, '')
    // The markers are consumed rather than shown, and the columns line up.
    expect(visible).toContain('● 工具')
    expect(visible).not.toContain('##')
    expect(visible).not.toContain('**')
    expect(visible).not.toContain('|---')
    expect(visible).toContain('read  │ 读取文本文件内容')
    expect(visible).toContain('write │ 创建新文件')
    expect(visible.split('\n').some(row => /^─+┼─+$/.test(row.trim()))).toBe(true)
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

  it('shows the product title only once across multiple turns', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setHeader(width => buildSplash(
      { title: 'DeepSeek Harness TUI', directory: 'repo', tips: ['/help for commands'] },
      width,
      UNICODE_GLYPHS,
    ))
    for (const turn of [1, 2, 3]) {
      const seq = (turn - 1) * 3
      store.append({ seq: seq + 1, kind: 'user', text: `question ${String(turn)}` })
      store.append({ seq: seq + 2, kind: 'assistant-final', text: `answer ${String(turn)}` })
      store.append({ seq: seq + 3, kind: 'turn-end', text: 'completed' })
    }
    const { screen } = mount(store, {}, { columns: 80, rows: 40 })
    await settle()
    expect(screen().match(/DeepSeek Harness TUI/g)).toHaveLength(1)
  })

  it('writes settled rows to the terminal once, so the wheel can reach them', async () => {
    // The banner and every settled turn are handed to the terminal as static
    // output. Written once, they are the terminal's rows afterwards: its own
    // scrollback holds them, which is what the wheel scrolls. Repainting them
    // every frame — what the viewport model did — put them somewhere no
    // terminal could scroll to.
    const store = new TuiStore(200)
    store.setHeader(width => buildSplash(
      { title: 'DeepSeek Harness TUI', directory: 'repo', tips: ['/help for commands'] },
      width,
      UNICODE_GLYPHS,
    ))
    for (let seq = 1; seq <= 60; seq++) {
      store.append({ seq, kind: 'user', text: `line ${String(seq)}` })
    }
    const { stdout } = mount(store)
    await settle()
    const written = (needle: string): number =>
      stdout.frames.filter(frame => frame.includes(needle)).length
    // Everything is on the terminal, however far back it is.
    expect(written('Tip: /help for commands')).toBe(1)
    expect(written('line 1')).toBeGreaterThan(0)
    expect(written('line 60')).toBeGreaterThan(0)

    // A further turn does not rewrite a single row of what came before.
    const before = stdout.frames.length
    store.append({ seq: 61, kind: 'user', text: 'line 61' })
    await settle()
    const since = stdout.frames.slice(before).join('')
    expect(since).toContain('line 61')
    expect(since).not.toContain('Tip: /help for commands')
  })

  it('keeps an unsettled call and everything after it in the live frame', async () => {
    // Scrollback is append-only, so one running call pins every row after it:
    // its own body still streams, and its status glyph is still moving.
    const store = new TuiStore(200)
    store.setColumns(80)
    store.append({ seq: 1, kind: 'user', text: 'settled turn' })
    store.append({ seq: 2, kind: 'tool-call', callId: 'c1', name: 'bash', text: 'streaming' })
    store.append({ seq: 3, kind: 'user', text: 'after the call' })
    const { stdout, screen } = mount(store)
    await settle()
    // The running card is repainted, so it lands in more than one write.
    expect(stdout.frames.filter(frame => frame.includes('settled turn'))).toHaveLength(1)
    expect(screen()).toContain('[running]')
    expect(screen()).toContain('after the call')
  })


  it('never emits the escape that would wipe the scrollback it just wrote', async () => {
    // Ink falls back to `clearTerminal` — `ESC[2J ESC[3J ESC[H`, which erases
    // the scroll buffer itself — as soon as a frame is as tall as the terminal
    // (`ink.js:121`). That would throw away every row this design just handed to
    // the terminal, so the frame has to stay strictly shorter, on any size.
    for (const rows of [6, 10, 24]) {
      const store = new TuiStore(200)
      store.setInteractive(true)
      store.setHeader(width => buildSplash(
        { title: 'DeepSeek Harness TUI', directory: 'repo', tips: ['/help for commands'] },
        width, UNICODE_GLYPHS,
      ))
      for (let seq = 1; seq <= 40; seq++) {
        store.append({ seq, kind: 'user', text: `line ${String(seq)} ${'wide '.repeat(20)}` })
      }
      const { stdout } = mount(store, {}, { columns: 60, rows })
      await settle()
      expect(stdout.frames.join('')).not.toContain(`${ESC}[3J`)
    }
  })

  it('consumes wheel reports without typing them', async () => {
    // The wheel belongs to the terminal now, but a report can still arrive when
    // `/mouse` claimed it. It must never reach the composer as text.
    const store = new TuiStore(200)
    store.append({ seq: 1, kind: 'user', text: 'hello' })
    const { screen, type } = mount(store)
    await settle()
    await type('[<64;10;5M'.repeat(4))
    expect(screen()).not.toContain('64;10;5')
  })

  it('folds the preamble from the second turn on, and spaces the answer off the card', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    const preamble = 'I cannot browse directly.\nSo I will search instead.\nOne moment.'
    let seq = 0
    for (const turn of [1, 2]) {
      store.append({ seq: ++seq, kind: 'user', text: `question ${String(turn)}` })
      store.append({ seq: ++seq, kind: 'assistant-delta', text: preamble })
      store.append({ seq: ++seq, kind: 'tool-call', text: '{}', name: 'search', callId: `c${String(turn)}` })
      store.append({ seq: ++seq, kind: 'tool-result', text: 'found it', callId: `c${String(turn)}` })
      store.append({ seq: ++seq, kind: 'assistant-delta', text: `answer ${String(turn)}` })
      store.append({ seq: ++seq, kind: 'turn-end', text: 'completed' })
    }
    const { screen } = mount(store, {}, { columns: 80, rows: 44 })
    await settle()
    const rows = screen().split('\n')
    const firstPreamble = rows.findIndex(row => row.includes('I cannot browse directly'))
    const secondPreamble = rows.findIndex(
      (row, at) => at > firstPreamble && row.includes('I cannot browse directly'),
    )
    expect(firstPreamble).toBeGreaterThan(-1)
    expect(secondPreamble).toBeGreaterThan(firstPreamble)
    // Turn one says its piece in full; turn two has said it before, so the same
    // narration collapses behind the ordinary expand hint.
    expect(rows[firstPreamble + 1]).toContain('So I will search instead')
    expect(rows[secondPreamble + 1]).toContain('ctrl+o to expand')
    // Each answer is lifted off the card above it by one blank row.
    for (const turn of [1, 2]) {
      const at = rows.findIndex(row => row.includes(`answer ${String(turn)}`))
      expect(at, `answer ${String(turn)}`).toBeGreaterThan(0)
      expect(rows[at - 1]?.trim(), `answer ${String(turn)}`).toBe('')
    }
  })

  it('wraps a wide line instead of cutting it off', async () => {
    const store = new TuiStore(50)
    store.append({ seq: 1, kind: 'user', text: '修复'.repeat(60) })
    const { screen } = mount(store, {}, { columns: 40, rows: 24 })
    await settle()
    const visible = screen().replace(/\[[0-?]*[ -/]*[@-~]/g, '')
    for (const line of visible.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(40)
    // The text continues onto further rows rather than ending in an ellipsis.
    const wrapped = visible.split('\n').filter(line => line.includes('修复'))
    expect(wrapped.length).toBeGreaterThan(1)
    expect(wrapped[0]?.startsWith('> ')).toBe(true)
    for (const continuation of wrapped.slice(1)) expect(continuation.startsWith('  ')).toBe(true)
    expect(visible).not.toContain('…')
  })
})

describe('running feedback', () => {
  it('shows the running tool activity declared by its presenter', async () => {
    let now = 1_000_000
    const clock = (): number => now
    const store = new TuiStore(50, {}, undefined, clock)
    store.setToolPresenter(() => ({
      call: { card: 'read', title: 'Read src/app.tsx', activity: 'Reading src/app.tsx' },
    }))
    store.setInteractive(true)
    store.setStatus('running')
    store.append({ seq: 1, kind: 'tool-call', text: '{}', name: 'read', callId: 'c1' })
    now += 4_000
    const { screen } = mount(store, {}, { columns: 80, rows: 24 }, clock)
    await settle()
    expect(screen()).toContain('Reading src/app.tsx')
    expect(screen()).not.toContain('Working…')
  })

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

  it('never erases the whole screen while streaming', async () => {
    // Ink falls back to `clearTerminal` for any frame that reaches the terminal
    // height (`ink.js:121`). Repeating that on every render is what a user sees
    // as flicker, so the frame must stay short enough to be patched in place.
    const store = new TuiStore(200)
    store.setInteractive(true)
    store.append({ seq: 1, kind: 'user', text: '你是谁' })
    store.setStatus('running')
    const { stdout } = mount(store)
    await settle()
    const before = stdout.frames.length
    for (let step = 0; step < 20; step++) {
      store.append({
        seq: 2 + step, kind: 'assistant-delta', text: '我是一个编码助手。', messageId: 'm1',
      })
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await settle()
    const streamed = stdout.frames.slice(before)
    expect(streamed.length).toBeGreaterThan(0)
    expect(streamed.filter(frame => frame.includes(`${ESC}[2J`))).toEqual([])
  })

  it('never erases the whole screen while an approval is pending', async () => {
    // The approval region is the tallest thing the frame can grow: a blank row,
    // a title, a preview of the call and one row per answer. Budgeting fewer
    // rows for it than it renders put the frame over the terminal height and
    // back onto `clearTerminal` — with the spinner running, on every tick.
    const store = new TuiStore(200)
    store.setInteractive(true)
    store.append({ seq: 1, kind: 'user', text: '简单使用一些工具' })
    for (let step = 0; step < 30; step++) {
      store.append({
        seq: 2 + step, kind: 'assistant-delta', text: '好的，我来看看。', messageId: 'm1',
      })
    }
    store.append({
      seq: 100, kind: 'tool-call', callId: 'c1', name: 'bash',
      text: JSON.stringify({ command: 'ls -la /etc && cat /etc/hosts' }),
    })
    store.setStatus('running')
    store.setApproval({
      id: 1, toolName: 'bash', callId: 'c1', reason: 'write outside the workspace',
    })
    const { stdout, screen } = mount(store)
    await settle()
    // The answers are what the pending run is waiting on: they must be there.
    expect(screen()).toContain('Approve bash?')
    expect(screen()).toContain('allow once')
    expect(screen()).toContain('reject')
    const before = stdout.frames.length
    // The spinner keeps repainting while the approval waits; that is the loop
    // the flicker lived in.
    await new Promise(resolve => setTimeout(resolve, 400))
    const waiting = stdout.frames.slice(before)
    expect(waiting.length).toBeGreaterThan(0)
    expect(waiting.filter(frame => frame.includes(`${ESC}[2J`))).toEqual([])
    // Staying under the terminal height is only half of it: Ink's ordinary
    // repaint erases every row it wrote last time, which blanks a full-height
    // frame just as visibly. Each spinner tick must land as an overwrite of the
    // rows that changed, and erase nothing.
    expect(waiting.filter(frame => frame.includes(`${ESC}[2K`))).toEqual([])
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

  it('keeps the focused completion on screen in a list longer than the budget', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setCommands(Array.from({ length: 12 }, (_, index) => ({
      name: `cmd${String(index).padStart(2, '0')}`,
      description: `command ${String(index)}`,
    })))
    const { type, screen } = mount(store)
    await settle()
    await type('/cmd')
    const down = `${String.fromCharCode(27)}[B`
    for (let step = 0; step < 9; step++) await type(down)
    // The window follows the focus instead of pinning to the head of the list,
    // and it says how many candidates it is hiding.
    expect(screen()).toContain('> /cmd09')
    expect(screen()).toContain('more')
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

  it('sends the rejection reason with the rejection, in one step', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setApproval({ id: 1, toolName: 'bash' })
    const { calls, type, screen } = mount(store, {}, { columns: 80, rows: 30 })
    await settle()
    expect(screen()).toContain('reject, and say why')
    // Row 3 is `reject, and say why`: allow once, reject, reject-and-say-why.
    await type('3')
    expect(screen()).toContain('reason:')
    // Deciding is deferred until the reason is in: the prompt is still open.
    expect(calls.decideApproval).not.toHaveBeenCalled()
    await type('needs a dry run first')
    await type('\r')
    expect(calls.decideApproval).toHaveBeenLastCalledWith(false)
    expect(calls.submit).toHaveBeenLastCalledWith('needs a dry run first')
  })

  it('backs out of the reason field without having decided anything', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setApproval({ id: 1, toolName: 'bash' })
    const { calls, type, screen } = mount(store, {}, { columns: 80, rows: 30 })
    await settle()
    await type('3')
    await type('oops')
    await type(String.fromCharCode(27))
    expect(calls.decideApproval).not.toHaveBeenCalled()
    expect(screen()).not.toContain('reason:')
    // The list is back, and its Esc is the one that fails closed.
    await type(String.fromCharCode(27))
    expect(calls.decideApproval).toHaveBeenLastCalledWith(false)
  })

  it('keeps n rejecting outright, whatever else the list has grown', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.setApproval({ id: 1, toolName: 'bash' })
    const { calls, type, screen } = mount(store, {}, { columns: 80, rows: 30 })
    await settle()
    await type('n')
    expect(calls.decideApproval).toHaveBeenLastCalledWith(false)
    expect(calls.submit).not.toHaveBeenCalled()
    expect(screen()).not.toContain('reason:')
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

  it('opens the requested startup browser once the session becomes interactive', async () => {
    const store = new TuiStore(50)
    store.setSessions([
      { id: 'session-old', createdAt: 1_000, live: false, persisted: true, cwd: '/repo' },
    ])
    const { calls, screen } = mount(
      store, {}, { columns: 80, rows: 24 }, Date.now, emptyBrowser,
    )
    await settle()
    expect(screen()).not.toContain('Sessions')
    store.setInteractive(true)
    await settle()
    expect(screen()).toContain('Sessions')
    expect(screen()).toContain('session-old')
    expect(calls.listSessions).toHaveBeenCalledOnce()
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

  it('opens a searchable transcript screen without disturbing the composer', async () => {
    const store = new TuiStore(50)
    store.setInteractive(true)
    store.append({ seq: 1, kind: 'user', text: 'alpha marker' })
    store.append({ seq: 2, kind: 'assistant-final', text: 'beta answer', messageId: 'm1' })
    const { type, screen } = mount(store, {}, { columns: 80, rows: 16 })
    await settle()
    await type(String.fromCharCode(20))
    expect(screen()).toContain('Transcript')
    expect(screen()).toContain('/ search')
    await type('/')
    await type('alpha')
    await type('\r')
    expect(screen()).toContain('1/1')
    await type('y')
    expect(screen()).toContain('clipboard unavailable')
    await type('r')
    expect(screen()).toContain('ctrl+p commands')
    expect(screen()).toContain('> alpha marker')
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
