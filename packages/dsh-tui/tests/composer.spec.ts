import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  backspaceComposer, caretLine, clearComposer, deleteComposer, emptyComposer,
  historyComposer, insertComposer, moveComposer, newlineComposer, promptTone, submitComposer,
  type ComposerDeletion, type ComposerMotion, type ComposerState,
} from '../src/composer.ts'

/** Build a state from a draft with `|` marking the caret. */
function at(marked: string): ComposerState {
  const cursor = Array.from(marked.slice(0, marked.indexOf('|'))).length
  return { ...emptyComposer, draft: marked.replace('|', ''), cursor }
}

/** Render a state back into the `|` notation. */
function show(state: ComposerState): string {
  const characters = Array.from(state.draft)
  return `${characters.slice(0, state.cursor).join('')}|${characters.slice(state.cursor).join('')}`
}

const MOTIONS: readonly ComposerMotion[] = [
  'left', 'right', 'word-left', 'word-right', 'line-start', 'line-end', 'up', 'down',
]
const DELETIONS: readonly ComposerDeletion[] = [
  'back-char', 'forward-char', 'back-word', 'to-line-start', 'to-line-end',
]

describe('composer state', () => {
  it('keeps multiline, bracketed paste, and IME text in one draft', () => {
    let state = insertComposer(emptyComposer, '第一行')
    state = newlineComposer(state)
    state = insertComposer(state, '[200~second\nthird[201~')
    expect(state.draft).toBe('第一行\nsecond\nthird')
    state = backspaceComposer(state)
    expect(state.draft).toBe('第一行\nsecond\nthir')
    // Ink strips the leading ESC, so a marker can also arrive bare.
    expect(insertComposer(emptyComposer, '[200~bare[201~').draft).toBe('bare')
  })

  it('submits non-empty drafts and navigates stable history', () => {
    const first = submitComposer(insertComposer(emptyComposer, 'one'))
    const second = submitComposer(insertComposer(first.state, 'two'))
    expect(second.text).toBe('two')
    const previous = historyComposer(second.state, -1)
    expect(previous.draft).toBe('two')
    expect(previous.cursor).toBe(3)
    expect(historyComposer(previous, -1).draft).toBe('one')
    expect(historyComposer(historyComposer(previous, -1), 1).draft).toBe('two')
  })
})

describe('caret editing', () => {
  it('inserts at the caret rather than at the end', () => {
    expect(show(insertComposer(at('ab|cd'), 'XY'))).toBe('abXY|cd')
  })

  it('counts a surrogate pair and a wide glyph as one step', () => {
    expect(show(moveComposer(at('|🙂中x'), 'right'))).toBe('🙂|中x')
    expect(show(moveComposer(at('🙂中|x'), 'left'))).toBe('🙂|中x')
  })

  it('moves by word across whitespace', () => {
    expect(show(moveComposer(at('one two  three|'), 'word-left'))).toBe('one two  |three')
    expect(show(moveComposer(at('one two  |three'), 'word-left'))).toBe('one |two  three')
    expect(show(moveComposer(at('|one two'), 'word-right'))).toBe('one |two')
  })

  it('jumps within the logical line, not the whole draft', () => {
    expect(show(moveComposer(at('first\nsec|ond\nthird'), 'line-start'))).toBe('first\n|second\nthird')
    expect(show(moveComposer(at('first\nsec|ond\nthird'), 'line-end'))).toBe('first\nsecond|\nthird')
  })

  it('keeps the column when moving between lines', () => {
    expect(show(moveComposer(at('abcdef\ngh|ij'), 'up'))).toBe('ab|cdef\nghij')
    expect(show(moveComposer(at('ab|cdef\nghij'), 'down'))).toBe('abcdef\ngh|ij')
    // A shorter neighbouring line clamps to its end instead of overshooting.
    expect(show(moveComposer(at('ab\nlonger|line'), 'up'))).toBe('ab|\nlongerline')
  })

  it('clamps at both ends instead of wrapping', () => {
    expect(show(moveComposer(at('|abc'), 'left'))).toBe('|abc')
    expect(show(moveComposer(at('abc|'), 'right'))).toBe('abc|')
    expect(show(moveComposer(at('abc|'), 'down'))).toBe('abc|')
  })

  it('deletes each region relative to the caret', () => {
    expect(show(deleteComposer(at('ab|cd'), 'back-char'))).toBe('a|cd')
    expect(show(deleteComposer(at('ab|cd'), 'forward-char'))).toBe('ab|d')
    expect(show(deleteComposer(at('one two|'), 'back-word'))).toBe('one |')
    expect(show(deleteComposer(at('a\nbc|de'), 'to-line-start'))).toBe('a\n|de')
    expect(show(deleteComposer(at('a\nbc|de'), 'to-line-end'))).toBe('a\nbc|')
  })

  it('is a no-op when the deleted region is empty', () => {
    expect(show(deleteComposer(at('|abc'), 'back-char'))).toBe('|abc')
    expect(show(deleteComposer(at('abc|'), 'to-line-end'))).toBe('abc|')
  })

  it('clears the draft without touching the history', () => {
    const submitted = submitComposer(insertComposer(emptyComposer, 'kept'))
    const cleared = clearComposer(insertComposer(submitted.state, 'scratch'))
    expect(cleared.draft).toBe('')
    expect(cleared.cursor).toBe(0)
    expect(cleared.history).toEqual(['kept'])
  })

  it('reports the caret line for vertical-key routing', () => {
    expect(caretLine(at('a|b'))).toEqual({ index: 0, count: 1, column: 1 })
    expect(caretLine(at('a\nb|c\nd'))).toEqual({ index: 1, count: 3, column: 1 })
    expect(caretLine(at('a\nb\nd|'))).toEqual({ index: 2, count: 3, column: 1 })
  })
})

describe('caret invariants', () => {
  const draft = fc.string({ maxLength: 40 })
  const cursorOf = (text: string): fc.Arbitrary<number> =>
    fc.integer({ min: 0, max: Array.from(text).length })

  it('keeps the caret inside the draft under any motion or deletion', () => {
    fc.assert(fc.property(
      draft,
      fc.array(fc.oneof(fc.constantFrom(...MOTIONS), fc.constantFrom(...DELETIONS)), { maxLength: 12 }),
      (text, steps) => {
        let state: ComposerState = { ...emptyComposer, draft: text, cursor: Array.from(text).length }
        for (const step of steps) {
          state = MOTIONS.includes(step as ComposerMotion)
            ? moveComposer(state, step as ComposerMotion)
            : deleteComposer(state, step as ComposerDeletion)
          expect(state.cursor).toBeGreaterThanOrEqual(0)
          expect(state.cursor).toBeLessThanOrEqual(Array.from(state.draft).length)
        }
      },
    ))
  })

  it('round-trips an insert through a backwards delete of the same length', () => {
    const placed = draft.chain(text => fc.tuple(fc.constant(text), cursorOf(text)))
    fc.assert(fc.property(
      placed,
      // A paste marker is stripped on insert, so it has no deletions to match.
      fc.string({ maxLength: 8 }).filter(value => !/\[20[01]~/.test(value)).filter(value => !value.includes('')),
      ([text, cursor], inserted) => {
        const start: ComposerState = { ...emptyComposer, draft: text, cursor }
        let state = insertComposer(start, inserted)
        for (let step = 0; step < Array.from(inserted).length; step++) {
          state = deleteComposer(state, 'back-char')
        }
        expect(state.draft).toBe(text)
        expect(state.cursor).toBe(cursor)
      },
    ))
  })
})

describe('prompt tone', () => {
  it('marks the modes that change what a keystroke can do', () => {
    expect(promptTone('danger-full-access')).toBe('mode-danger')
    expect(promptTone('read-only')).toBe('mode-restricted')
    expect(promptTone('workspace-write')).toBe('user')
  })

  it('keeps the ordinary tone for a mode it cannot read', () => {
    // Guessing how permissive an unknown preset is would be the one wrong
    // answer here; the status line still shows its name in full.
    expect(promptTone(undefined)).toBe('user')
    expect(promptTone('some-future-preset')).toBe('user')
  })
})
