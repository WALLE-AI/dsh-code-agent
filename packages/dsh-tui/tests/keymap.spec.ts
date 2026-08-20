import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fromInkKey, isReturn, KEY_BINDINGS, resolveKey,
  type InkKeyLike, type KeyContext, type KeyEvent, type UiSurface,
} from '../src/keymap.ts'

const NO_KEY: InkKeyLike = Object.freeze({
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
  pageDown: false, pageUp: false, return: false, escape: false,
  ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
})

const OPEN: KeyContext = {
  interactive: true, cancelArmed: false, questionHasOptions: false,
  approvalOptionCount: 4,
  draftEmpty: true, canMoveUp: false, canMoveDown: false,
  completionOpen: false, completionExact: false,
}

function press(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return { input: '', ctrl: false, meta: false, shift: false, ...overrides }
}

const SURFACES: readonly UiSurface[] = [
  'approval', 'approval-feedback', 'question', 'palette', 'help', 'browser',
  'completion', 'transcript-screen', 'transcript', 'composer',
]

describe('key translation', () => {
  it('maps an Ink keypress onto the renderer-independent event', () => {
    expect(fromInkKey('', { ...NO_KEY, pageUp: true })).toEqual({
      input: '', ctrl: false, meta: false, shift: false, name: 'pageUp',
    })
    expect(fromInkKey('p', { ...NO_KEY, ctrl: true })).toEqual({
      input: 'p', ctrl: true, meta: false, shift: false,
    })
  })

  it('treats a bare CR or LF chunk as a return', () => {
    expect(isReturn(press({ input: '\r' }))).toBe(true)
    expect(isReturn(press({ input: '\n\n' }))).toBe(true)
    expect(isReturn(press({ name: 'return' }))).toBe(true)
    // A paste that merely contains a newline is text, not a commit.
    expect(isReturn(press({ input: 'first\nsecond' }))).toBe(false)
  })
})

describe('global precedence', () => {
  it('routes Ctrl+C to the bounded shutdown from every surface', () => {
    for (const surface of SURFACES) {
      expect(resolveKey(surface, press({ input: 'c', ctrl: true }), OPEN))
        .toEqual({ kind: 'cancel-arm' })
      expect(resolveKey(surface, press({ input: 'c', ctrl: true }), { ...OPEN, cancelArmed: true }))
        .toEqual({ kind: 'cancel' })
    }
  })

  it('swallows keys a modal does not understand instead of leaking them', () => {
    expect(resolveKey('approval', press({ input: 'q' }), OPEN)).toBeUndefined()
    expect(resolveKey('palette', press({ name: 'left' }), OPEN)).toBeUndefined()
  })
})

describe('session browser surface', () => {
  it('filters as you type, with no mode to enter first', () => {
    expect(resolveKey('browser', press({ input: 'repo' }), OPEN))
      .toEqual({ kind: 'browser-type', text: 'repo' })
  })

  it('moves by row and by page', () => {
    expect(resolveKey('browser', press({ name: 'down' }), OPEN))
      .toEqual({ kind: 'browser-move', delta: 1 })
    expect(resolveKey('browser', press({ name: 'pageUp' }), OPEN))
      .toEqual({ kind: 'browser-page', delta: -1 })
  })

  it('resumes only on a bare Enter', () => {
    expect(resolveKey('browser', press({ name: 'return' }), OPEN))
      .toEqual({ kind: 'browser-accept' })
    expect(resolveKey('browser', press({ name: 'return', ctrl: true }), OPEN)).toBeUndefined()
  })

  it('peels one layer per Esc', () => {
    expect(resolveKey('browser', press({ name: 'escape' }), OPEN))
      .toEqual({ kind: 'browser-escape' })
  })
})

describe('approval surface', () => {
  it('keeps y and n meaning allow-now and reject-now, whatever the list holds', () => {
    expect(resolveKey('approval', press({ input: 'Y' }), OPEN))
      .toEqual({ kind: 'approval-shortcut', allowed: true })
    expect(resolveKey('approval', press({ input: 'N' }), OPEN))
      .toEqual({ kind: 'approval-shortcut', allowed: false })
  })

  it('addresses the list by position on a digit', () => {
    expect(resolveKey('approval', press({ input: '1' }), OPEN))
      .toEqual({ kind: 'approval-select', index: 0 })
    expect(resolveKey('approval', press({ input: '4' }), OPEN))
      .toEqual({ kind: 'approval-select', index: 3 })
    // A digit past the end of the list answers nothing at all.
    expect(resolveKey('approval', press({ input: '5' }), OPEN)).toBeUndefined()
  })

  it('fails closed on Esc', () => {
    expect(resolveKey('approval', press({ name: 'escape' }), OPEN))
      .toEqual({ kind: 'approval-shortcut', allowed: false })
  })

  it('moves between the answers', () => {
    expect(resolveKey('approval', press({ name: 'up' }), OPEN))
      .toEqual({ kind: 'approval-move', delta: -1 })
    expect(resolveKey('approval', press({ name: 'down' }), OPEN))
      .toEqual({ kind: 'approval-move', delta: 1 })
  })

  it('confirms only on a bare Enter', () => {
    expect(resolveKey('approval', press({ name: 'return' }), OPEN))
      .toEqual({ kind: 'approval-confirm' })
    // A modifier left over from the previous keystroke must not answer a prompt
    // that gates a tool run.
    for (const modifier of [{ ctrl: true }, { meta: true }, { shift: true }]) {
      expect(resolveKey('approval', press({ name: 'return', ...modifier }), OPEN))
        .toBeUndefined()
    }
  })
})

describe('approval feedback surface', () => {
  it('takes the typed reason', () => {
    expect(resolveKey('approval-feedback', press({ input: 'a' }), OPEN))
      .toEqual({ kind: 'approval-feedback-type', text: 'a' })
    // A digit is text here, not an answer index: the list is not showing.
    expect(resolveKey('approval-feedback', press({ input: '2' }), OPEN))
      .toEqual({ kind: 'approval-feedback-type', text: '2' })
    expect(resolveKey('approval-feedback', press({ name: 'backspace' }), OPEN))
      .toEqual({ kind: 'approval-feedback-backspace' })
  })

  it('peels one layer on Esc rather than answering', () => {
    // The fail-closed Esc is the one on the list. Opening the field by mistake
    // must be undoable without having decided anything.
    expect(resolveKey('approval-feedback', press({ name: 'escape' }), OPEN))
      .toEqual({ kind: 'approval-feedback-cancel' })
  })

  it('submits only on a bare Enter', () => {
    expect(resolveKey('approval-feedback', press({ name: 'return' }), OPEN))
      .toEqual({ kind: 'approval-feedback-submit' })
    expect(resolveKey('approval-feedback', press({ name: 'return', ctrl: true }), OPEN))
      .toBeUndefined()
  })
})

describe('question surface', () => {
  it('prefers an option index over free text for digits', () => {
    expect(resolveKey('question', press({ input: '3' }), OPEN))
      .toEqual({ kind: 'question-choose', index: 2 })
  })

  it('toggles with Space only while the question has options', () => {
    expect(resolveKey('question', press({ input: ' ' }), OPEN))
      .toEqual({ kind: 'question-type', text: ' ' })
    expect(resolveKey('question', press({ input: ' ' }), { ...OPEN, questionHasOptions: true }))
      .toEqual({ kind: 'question-toggle' })
  })

  it('absorbs printable text into the custom answer', () => {
    expect(resolveKey('question', press({ input: '中' }), OPEN))
      .toEqual({ kind: 'question-type', text: '中' })
  })
})

describe('open cascade', () => {
  it('opens the palette and the picker only in an interactive session', () => {
    expect(resolveKey('composer', press({ input: 'p', ctrl: true }), OPEN))
      .toEqual({ kind: 'open-palette' })
    expect(resolveKey('composer', press({ input: 'r', ctrl: true }), { ...OPEN, interactive: false }))
      .toBeUndefined()
  })

  it('keeps navigation keys out of the draft while the transcript has focus', () => {
    expect(resolveKey('transcript', press({ input: 'k' }), OPEN))
      .toEqual({ kind: 'scroll', direction: -1, page: false })
    expect(resolveKey('transcript', press({ input: 'j' }), OPEN))
      .toEqual({ kind: 'scroll', direction: 1, page: false })
    expect(resolveKey('transcript', press({ input: 'hello' }), OPEN)).toBeUndefined()
  })

  it('offers stacked contexts from the innermost layer outward', () => {
    const completion = { ...OPEN, completionOpen: true }
    expect(resolveKey(['completion', 'composer'], press({ name: 'up' }), completion))
      .toEqual({ kind: 'completion-move', delta: -1 })
    expect(resolveKey(['completion', 'composer'], press({ input: 'x' }), completion))
      .toEqual({ kind: 'composer-insert', text: 'x' })
    expect(resolveKey(['approval', 'composer'], press({ input: 'x' }), OPEN)).toBeUndefined()
  })

  it('owns transcript search, navigation, and copy keys in its screen context', () => {
    expect(resolveKey('composer', press({ input: 't', ctrl: true }), OPEN))
      .toEqual({ kind: 'transcript-open' })
    expect(resolveKey('transcript-screen', press({ input: '/' }), OPEN))
      .toEqual({ kind: 'transcript-search-open' })
    expect(resolveKey('transcript-screen', press({ input: 'N' }), OPEN))
      .toEqual({ kind: 'transcript-match', direction: -1 })
    expect(resolveKey('transcript-screen', press({ input: 'Y' }), OPEN))
      .toEqual({ kind: 'transcript-copy', wholeEntry: true })
    expect(resolveKey('transcript-screen', press({ input: 'r' }), OPEN))
      .toEqual({ kind: 'transcript-restore-draft' })
    expect(resolveKey(
      'transcript-screen', press({ input: 'x' }), { ...OPEN, transcriptSearch: true },
    )).toEqual({ kind: 'transcript-search-type', text: 'x' })
  })

  it('returns to the composer on Enter or Esc without arming a cancel', () => {
    expect(resolveKey('transcript', press({ name: 'escape' }), OPEN))
      .toEqual({ kind: 'focus-composer' })
    expect(resolveKey('transcript', press({ name: 'return' }), OPEN))
      .toEqual({ kind: 'focus-composer' })
  })

  it('arms Esc once and cancels on the second press', () => {
    expect(resolveKey('composer', press({ name: 'escape' }), OPEN))
      .toEqual({ kind: 'cancel-arm' })
    expect(resolveKey('composer', press({ name: 'escape' }), { ...OPEN, cancelArmed: true }))
      .toEqual({ kind: 'cancel' })
  })

  it('scrolls a whole page with PgUp and PgDn from either pane', () => {
    for (const surface of ['composer', 'transcript'] as const) {
      expect(resolveKey(surface, press({ name: 'pageUp' }), OPEN))
        .toEqual({ kind: 'scroll', direction: -1, page: true })
      expect(resolveKey(surface, press({ name: 'pageDown' }), OPEN))
        .toEqual({ kind: 'scroll', direction: 1, page: true })
    }
  })

  it('separates a newline from a send', () => {
    expect(resolveKey('composer', press({ name: 'return', ctrl: true }), OPEN))
      .toEqual({ kind: 'composer-newline' })
    expect(resolveKey('composer', press({ name: 'return' }), OPEN)).toEqual({ kind: 'submit' })
  })

  it('does not feed the composer in a one-shot session', () => {
    const oneShot = { ...OPEN, interactive: false }
    expect(resolveKey('composer', press({ input: 'x' }), oneShot)).toBeUndefined()
    expect(resolveKey('composer', press({ name: 'return' }), oneShot)).toBeUndefined()
    // Reading the transcript still works without an interactive composer.
    expect(resolveKey('composer', press({ name: 'pageUp' }), oneShot))
      .toEqual({ kind: 'scroll', direction: -1, page: true })
  })
})

describe('binding table', () => {
  it('documents every key the resolver acts on', () => {
    const documented = KEY_BINDINGS.map(binding => binding.keys).join(' ')
    for (const key of ['Ctrl+C', 'Esc', 'Tab', 'Ctrl+P', 'Ctrl+R', 'Ctrl+O', 'Ctrl+E', 'PgUp']) {
      expect(documented, `${key} must be documented`).toContain(key)
    }
  })

  it('is fully covered by the user guide', () => {
    // The guide wraps every key in backticks; the table stores them bare.
    const guide = readFileSync(
      join(import.meta.dirname, '../../../docs/tui-user-guide.md'),
      'utf8',
    ).replace(/`/g, '')
    for (const binding of KEY_BINDINGS) {
      // The guide groups keys differently, so each key in a set counts alone.
      for (const key of binding.keys.split(/ \/ |, /)) {
        expect(guide, `${key} is bound but undocumented`).toContain(key)
      }
    }
  })

  it('names a surface every binding can actually reach', () => {
    for (const binding of KEY_BINDINGS) {
      expect([...SURFACES, 'global']).toContain(binding.surface)
      expect(binding.description).not.toBe('')
    }
  })
})
