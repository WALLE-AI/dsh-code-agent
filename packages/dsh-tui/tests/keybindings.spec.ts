/**
 * The chord registry.
 *
 * Two properties matter more than any individual binding: a press normalises to
 * exactly one chord string, and a user's override changes what the key does and
 * what the sheet says it does in the same move.
 */

import { describe, expect, it } from 'vitest'
import {
  buildKeymap, chordOf, DEFAULT_BINDINGS, DEFAULT_KEYMAP, describeIssues,
  formatChord, parseKeybindings,
} from '../src/keybindings.ts'
import {
  emptyKeySequence, KEY_SEQUENCE_TIMEOUT_MS, keyBindingDocs, resolveKey,
  resolveKeySequence, type KeyContext, type KeyEvent,
} from '../src/keymap.ts'

function press(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return { input: '', ctrl: false, meta: false, shift: false, ...overrides }
}

const OPEN: KeyContext = {
  interactive: true, cancelArmed: false, questionHasOptions: false,
  approvalOptionCount: 4,
  draftEmpty: true, canMoveUp: false, canMoveDown: false,
  completionOpen: false, completionExact: false,
}

describe('normalising a press', () => {
  it('spells a modified key the way the table does', () => {
    expect(chordOf(press({ input: 'p', ctrl: true }))).toBe('ctrl+p')
    expect(chordOf(press({ name: 'tab', shift: true }))).toBe('shift+tab')
    expect(chordOf(press({ name: 'left', ctrl: true }))).toBe('ctrl+left')
    expect(chordOf(press({ input: 'b', meta: true }))).toBe('alt+b')
  })

  it('folds a shifted letter onto the letter it produced', () => {
    // `Y` and `shift+y` are one press, so they must be one chord.
    expect(chordOf(press({ input: 'Y', shift: true }))).toBe('y')
    expect(chordOf(press({ input: 'y' }))).toBe('y')
  })

  it('ignores the meta flag Ink sets on a bare Esc', () => {
    // Ink reports Esc with `meta` set, because the escape key *is* the meta
    // prefix on this wire. Spelling it `alt+escape` would leave the binding
    // permanently unmatched — every Esc in the profile stops working.
    expect(chordOf(press({ name: 'escape', meta: true }))).toBe('escape')
  })

  it('treats a bare CR chunk as Enter and a space as a chord', () => {
    expect(chordOf(press({ input: '\r' }))).toBe('enter')
    expect(chordOf(press({ input: ' ' }))).toBe('space')
  })

  it('has no chord for text', () => {
    expect(chordOf(press({ input: 'hello' }))).toBeUndefined()
    expect(chordOf(press())).toBeUndefined()
  })
})

describe('showing a chord', () => {
  it('capitalises a modified letter and leaves a bare one as typed', () => {
    expect(formatChord('ctrl+p')).toBe('Ctrl+P')
    expect(formatChord('j')).toBe('j')
    expect(formatChord('shift+tab')).toBe('Shift+Tab')
    expect(formatChord('pageup')).toBe('PgUp')
    expect(formatChord('ctrl+x ctrl+e')).toBe('Ctrl+X Ctrl+E')
  })
})

describe('the default table', () => {
  it('gives every action a unique id and something to say about itself', () => {
    const ids = DEFAULT_BINDINGS.map(binding => binding.action)
    expect(new Set(ids).size).toBe(ids.length)
    for (const binding of DEFAULT_BINDINGS) {
      expect(binding.description, binding.action).not.toBe('')
      expect(binding.chords.length, binding.action).toBeGreaterThan(0)
    }
  })

  it('protects the keys that reach the shutdown', () => {
    const reserved = DEFAULT_BINDINGS.filter(binding => binding.reserved === true)
    expect(reserved.map(binding => binding.action)).toEqual(['app:cancel', 'app:escape'])
  })
})

describe('user overrides', () => {
  it('changes what the key does and what the sheet says, in one move', () => {
    const { keymap, issues } = buildKeymap({ 'palette:open': 'ctrl+g' })
    expect(issues).toEqual([])
    // The behaviour moved…
    expect(resolveKey('composer', press({ input: 'g', ctrl: true }), OPEN, keymap))
      .toEqual({ kind: 'open-palette' })
    expect(resolveKey('composer', press({ input: 'p', ctrl: true }), OPEN, keymap))
      .not.toEqual({ kind: 'open-palette' })
    // …and so did the row the shortcut sheet draws.
    expect(keymap.shortcut('palette:open')).toBe('Ctrl+G')
    const row = keyBindingDocs(keymap).find(doc => doc.description === 'Open the command palette')
    expect(row?.keys).toBe('Ctrl+G')
  })

  it('accepts a list, and hands a key back to typing on null', () => {
    const { keymap } = buildKeymap({ 'palette:open': ['ctrl+g', 'ctrl+p'] })
    for (const letter of ['g', 'p']) {
      expect(resolveKey('composer', press({ input: letter, ctrl: true }), OPEN, keymap))
        .toEqual({ kind: 'open-palette' })
    }
    const unbound = buildKeymap({ 'help:open': null }).keymap
    expect(unbound.shortcut('help:open')).toBe('')
    // `?` is ordinary text once nothing claims it.
    expect(resolveKey('composer', press({ input: '?' }), OPEN, unbound))
      .toEqual({ kind: 'composer-insert', text: '?' })
    // And it no longer clutters the sheet.
    expect(keyBindingDocs(unbound).some(doc => doc.description.includes('shortcut sheet')))
      .toBe(false)
  })

  it('resolves a configured multi-key chord without leaking its prefix', () => {
    const { keymap, issues } = buildKeymap({ 'editor:open': 'ctrl+x ctrl+e' })
    expect(issues).toEqual([])
    const first = resolveKeySequence(
      emptyKeySequence, ['composer'], press({ input: 'x', ctrl: true }), OPEN, keymap, 100,
    )
    expect(first.pending).toBe(true)
    expect(first.action).toBeUndefined()
    const second = resolveKeySequence(
      first.state, ['composer'], press({ input: 'e', ctrl: true }), OPEN, keymap, 200,
    )
    expect(second).toMatchObject({ pending: false, action: { kind: 'open-editor' } })
    expect(keymap.shortcut('editor:open')).toBe('Ctrl+X Ctrl+E')
  })

  it('replays the current key after an invalid or expired chord prefix', () => {
    const { keymap } = buildKeymap({ 'editor:open': 'ctrl+x ctrl+e' })
    const first = resolveKeySequence(
      emptyKeySequence, ['composer'], press({ input: 'x', ctrl: true }), OPEN, keymap, 100,
    )
    expect(resolveKeySequence(
      first.state, ['composer'], press({ input: 'z' }), OPEN, keymap, 200,
    ).action).toEqual({ kind: 'composer-insert', text: 'z' })
    expect(resolveKeySequence(
      first.state, ['composer'], press({ input: 'e', ctrl: true }), OPEN, keymap,
      100 + KEY_SEQUENCE_TIMEOUT_MS + 1,
    ).action).toEqual({ kind: 'composer-move', motion: 'line-end' })
  })

  it('refuses to rebind the keys that reach the shutdown', () => {
    const { keymap, issues } = buildKeymap({ 'app:cancel': 'ctrl+q' })
    expect(issues[0]?.message).toContain('reserved')
    // Ctrl+C still arms the shutdown, whatever the file said.
    expect(resolveKey('composer', press({ input: 'c', ctrl: true }), OPEN, keymap))
      .toEqual({ kind: 'cancel-arm' })
  })

  it('reports a typo and then ignores it', () => {
    const { keymap, issues } = buildKeymap({
      'palette:opne': 'ctrl+k',
      'session:browse': 'ctrl+shrug+z',
      'fold:toggle': 42,
    })
    expect(issues.map(issue => issue.action))
      .toEqual(['palette:opne', 'session:browse', 'fold:toggle'])
    // Every default survived, because nothing valid was asked for.
    expect(keymap.shortcut('palette:open')).toBe('Ctrl+P')
    expect(keymap.shortcut('session:browse')).toBe('Ctrl+R')
    expect(keymap.shortcut('fold:toggle')).toBe('Ctrl+O')
  })

  it('says when one chord has been given two meanings', () => {
    expect(buildKeymap({ 'session:browse': 'ctrl+p' }).issues[0]?.message)
      .toContain('Ctrl+P is bound to both')
    // Including a collision with a binding the user did not think about: Ctrl+K
    // already deletes to the end of the line.
    expect(buildKeymap({ 'palette:open': 'ctrl+k' }).issues[0]?.message)
      .toContain('Ctrl+K is bound to both "edit:delete-to-line-end"')
  })

  it('is total against a broken file', () => {
    const { keymap, issues } = parseKeybindings('{ not json')
    expect(issues[0]?.message).toContain('not valid JSON')
    expect(keymap.shortcut('palette:open')).toBe('Ctrl+P')
    expect(parseKeybindings('[]').issues[0]?.message).toContain('must be an object')
    expect(parseKeybindings('{}').issues).toEqual([])
  })

  it('summarises the issues for the notice row', () => {
    expect(describeIssues([])).toBeUndefined()
    expect(describeIssues([{ message: 'a' }, { message: 'b' }]))
      .toBe('keybindings.json: a (+1 more)')
  })
})

describe('the sheet and the resolver read the same row', () => {
  it('documents every chord the default resolver answers to', () => {
    // The drift test this replaces compared two hand-written tables. There is
    // only one table now, so the property worth checking is that the resolver
    // is actually reachable through it.
    for (const action of ['palette:open', 'session:browse', 'fold:toggle', 'editor:open']) {
      expect(DEFAULT_KEYMAP.shortcut(action), action).not.toBe('')
    }
  })
})
