/**
 * The frame's derived state, tested without a terminal.
 *
 * These are the decisions that used to be observable only by rendering: who
 * owns the keyboard, which regions are visible, and what the layout budget
 * spends its rows on. They are pure now, so they are asserted directly.
 */

import { describe, expect, it } from 'vitest'
import { emptyComposer, insertComposer } from '../src/composer.ts'
import { emptyBrowser } from '../src/session-browser.ts'
import { TuiStore } from '../src/state.ts'
import { buildViewModel, emptyUiState, type UiState } from '../src/view-model.ts'
import { emptyViewport } from '../src/viewport.ts'

function model(store: TuiStore, ui: Partial<UiState> = {}, size = { rows: 24, columns: 80 }) {
  const state = store.snapshot()
  const merged: UiState = { ...emptyUiState, viewport: emptyViewport, ...ui }
  return buildViewModel({
    state,
    ui: merged,
    rows: size.rows,
    columns: size.columns,
    liveLines: state.lines,
    now: 1_000,
    animate: false,
  })
}

function interactiveStore(): TuiStore {
  const store = new TuiStore(50)
  store.setInteractive(true)
  store.setColumns(80)
  return store
}

describe('surface precedence', () => {
  it('gives the keyboard to the composer when nothing is open', () => {
    expect(model(interactiveStore()).surface).toBe('composer')
  })

  it('lets an approval outrank every other surface', () => {
    const store = interactiveStore()
    store.setApproval({ id: 1, callId: 'c1', toolName: 'bash' })
    const vm = model(store, { helpOpen: true, browser: emptyBrowser, palette: { query: '', index: 0 } })
    expect(vm.surface).toBe('approval')
    // A screen may not paint over a prompt the Agent is blocked on.
    expect(vm.browserOpen).toBe(false)
    expect(vm.helpVisible).toBe(false)
    expect(vm.paletteOpen).toBe(false)
    expect(vm.composerVisible).toBe(false)
  })

  it('keeps a queued questionnaire visible as a note while an approval shows', () => {
    const store = interactiveStore()
    store.setQuestion({
      id: 1,
      questions: [{ id: 'a', question: 'which?', options: [{ label: 'one' }] }],
    })
    store.setApproval({ id: 1, callId: 'c1', toolName: 'bash' })
    const vm = model(store)
    expect(vm.queuedPrompts).toBe(true)
    // The form itself is hidden; only the "1 more prompt queued" note remains.
    expect(vm.visibleQuestion).toBeUndefined()
    expect(vm.activeQuestion).toBeDefined()
  })

  it('orders the screens below a prompt but above the composer', () => {
    const store = interactiveStore()
    expect(model(store, { browser: emptyBrowser }).surface).toBe('browser')
    expect(model(store, { helpOpen: true }).surface).toBe('help')
    expect(model(store, { palette: { query: '', index: 0 } }).surface).toBe('palette')
    // The browser outranks the sheet, which outranks the palette.
    expect(model(store, { browser: emptyBrowser, helpOpen: true }).surface).toBe('browser')
    expect(model(store, { helpOpen: true, palette: { query: '', index: 0 } }).surface).toBe('help')
  })

  it('hands the keyboard to the transcript only when focus moved there', () => {
    expect(model(interactiveStore(), { focus: 'transcript' }).surface).toBe('transcript')
  })
})

describe('completion', () => {
  it('opens for a slash command at the head of the draft', () => {
    const store = interactiveStore()
    store.setCommands([{ name: 'compact', description: 'summarise' }])
    const vm = model(store, { composer: insertComposer(emptyComposer, '/comp') })
    expect(vm.completionOpen).toBe(true)
    expect(vm.completionMatches.map(item => item.value)).toContain('/compact')
    expect(vm.mentionNeedle).toBeUndefined()
  })

  it('reports the mention needle so the files are fetched once per token', () => {
    const store = interactiveStore()
    store.setFiles([{ path: 'src/app.tsx', directory: false }])
    const vm = model(store, { composer: insertComposer(emptyComposer, 'look at @src/a') })
    expect(vm.mentionNeedle).toBe('src/a')
  })

  it('stays closed for the token Esc dismissed it for', () => {
    const store = interactiveStore()
    store.setCommands([{ name: 'compact', description: 'summarise' }])
    const composer = insertComposer(emptyComposer, '/comp')
    expect(model(store, { composer, dismissed: 0 }).completionOpen).toBe(false)
    // A different token is a different list.
    expect(model(store, { composer, dismissed: 3 }).completionOpen).toBe(true)
  })

  it('marks the candidate exact once the token already spells it', () => {
    const store = interactiveStore()
    store.setCommands([{ name: 'compact', description: 'summarise' }])
    expect(model(store, { composer: insertComposer(emptyComposer, '/compact') }).completionExact)
      .toBe(true)
    expect(model(store, { composer: insertComposer(emptyComposer, '/comp') }).completionExact)
      .toBe(false)
  })
})

describe('layout budget', () => {
  it('keeps at least one transcript row on a very short terminal', () => {
    const vm = model(interactiveStore(), {}, { rows: 6, columns: 40 })
    expect(vm.layout.viewportRows).toBeGreaterThanOrEqual(1)
  })

  it('drops decoration before the interaction it decorates', () => {
    const store = interactiveStore()
    store.setApproval({
      id: 1, callId: 'c1', toolName: 'bash', reason: 'writes outside the workspace',
    })
    const roomy = model(store, {}, { rows: 40, columns: 80 })
    const cramped = model(store, {}, { rows: 8, columns: 80 })
    expect(roomy.layout.showStatus).toBe(true)
    // The answers themselves are never dropped, whatever else goes.
    expect(cramped.layout.viewportRows).toBeGreaterThanOrEqual(1)
    expect(cramped.layout.approvalPreviewRows)
      .toBeLessThanOrEqual(roomy.layout.approvalPreviewRows)
  })
})

describe('status row', () => {
  it('says what Esc does while a run is in flight', () => {
    const store = interactiveStore()
    store.setStatus('running')
    expect(model(store).statusHint).toContain('esc to interrupt')
  })

  it('replaces the notice with the armed-cancel warning', () => {
    const store = interactiveStore()
    store.setNotice('model switched')
    expect(model(store).notice).toBe('model switched')
    expect(model(store, { confirm: 'cancel' }).notice)
      .toBe('Press again to stop the current run')
  })
})
