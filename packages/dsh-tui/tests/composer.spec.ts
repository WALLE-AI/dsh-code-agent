import { describe, expect, it } from 'vitest'
import {
  backspaceComposer, emptyComposer, historyComposer, insertComposer,
  newlineComposer, submitComposer,
} from '../src/composer.ts'

describe('composer state', () => {
  it('keeps multiline, bracketed paste, and IME text in one draft', () => {
    let state = insertComposer(emptyComposer, '第一行')
    state = newlineComposer(state)
    state = insertComposer(state, '\u001B[200~second\nthird\u001B[201~')
    expect(state.draft).toBe('第一行\nsecond\nthird')
    state = backspaceComposer(state)
    expect(state.draft).toBe('第一行\nsecond\nthir')
  })

  it('submits non-empty drafts and navigates stable history', () => {
    const first = submitComposer(insertComposer(emptyComposer, 'one'))
    const second = submitComposer(insertComposer(first.state, 'two'))
    expect(second.text).toBe('two')
    const previous = historyComposer(second.state, -1)
    expect(previous.draft).toBe('two')
    expect(historyComposer(previous, -1).draft).toBe('one')
    expect(historyComposer(historyComposer(previous, -1), 1).draft).toBe('two')
  })
})
