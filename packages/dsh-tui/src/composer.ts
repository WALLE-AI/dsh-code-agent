/**
 * Draft editing model. The draft is a plain string plus a code-point cursor;
 * every motion and deletion is a pure transform so the editor can be tested
 * without a terminal. Indices are code points, never UTF-16 units, so a
 * surrogate pair or an accented character is one step.
 */

import type { RowTone } from './styling.ts'

export interface ComposerState {
  readonly draft: string
  /** Code-point index of the caret, always within `[0, length]`. */
  readonly cursor: number
  readonly history: readonly string[]
  readonly historyIndex: number
}

export type ComposerMotion =
  | 'left' | 'right'
  | 'word-left' | 'word-right'
  | 'line-start' | 'line-end'
  | 'up' | 'down'

export type ComposerDeletion =
  | 'back-char' | 'forward-char' | 'back-word'
  | 'to-line-start' | 'to-line-end'

export const emptyComposer: ComposerState = Object.freeze({
  draft: '', cursor: 0, history: [], historyIndex: -1,
})

/**
 * Tone of the composer prompt, by permission preset.
 *
 * The prompt is the one thing on screen at the moment of typing, so it is where
 * the mode belongs: `danger-full-access` runs tools with no approval at all and
 * has to look like it, and a read-only session should not read as one that can
 * write. A preset this profile does not recognise keeps the ordinary tone
 * rather than guessing at how permissive it is — the status line still names it
 * in full.
 *
 * @param mode - `activity.permission.current`, as reported by the session.
 */
export function promptTone(mode: string | undefined): RowTone {
  if (mode === undefined) return 'user'
  if (mode.includes('danger')) return 'mode-danger'
  if (mode.includes('read-only')) return 'mode-restricted'
  return 'user'
}

// Ink strips a leading ESC from every chunk, so the opening bracketed-paste
// marker can arrive without it. Both markers are removed wherever they occur:
// a long paste may also be split across chunks.
const PASTE_MARKER = new RegExp(`${String.fromCharCode(27)}?${String.raw`\[20[01]~`}`, 'g')

function pasteText(text: string): string {
  return text.replace(PASTE_MARKER, '')
}

function isSpace(character: string | undefined): boolean {
  return character !== undefined && /\s/.test(character)
}

/** Rebuild a state from its parts, clamping the caret into the new draft. */
function withDraft(state: ComposerState, characters: readonly string[], cursor: number): ComposerState {
  return {
    ...state,
    draft: characters.join(''),
    cursor: Math.max(0, Math.min(characters.length, cursor)),
    historyIndex: -1,
  }
}

/** Start of the logical line containing `cursor`. */
function lineStart(characters: readonly string[], cursor: number): number {
  let index = cursor
  while (index > 0 && characters[index - 1] !== '\n') index--
  return index
}

/** End of the logical line containing `cursor`, before its terminator. */
function lineEnd(characters: readonly string[], cursor: number): number {
  let index = cursor
  while (index < characters.length && characters[index] !== '\n') index++
  return index
}

function wordLeft(characters: readonly string[], cursor: number): number {
  let index = cursor
  while (index > 0 && isSpace(characters[index - 1])) index--
  while (index > 0 && !isSpace(characters[index - 1])) index--
  return index
}

function wordRight(characters: readonly string[], cursor: number): number {
  let index = cursor
  while (index < characters.length && !isSpace(characters[index])) index++
  while (index < characters.length && isSpace(characters[index])) index++
  return index
}

/** Move to the same column of the neighbouring logical line. */
function verticalTarget(
  characters: readonly string[],
  cursor: number,
  direction: -1 | 1,
): number {
  const start = lineStart(characters, cursor)
  const column = cursor - start
  if (direction === -1) {
    if (start === 0) return 0
    const previousStart = lineStart(characters, start - 1)
    return Math.min(previousStart + column, start - 1)
  }
  const end = lineEnd(characters, cursor)
  if (end >= characters.length) return characters.length
  const nextEnd = lineEnd(characters, end + 1)
  return Math.min(end + 1 + column, nextEnd)
}

/** Insert text at the caret and leave the caret after it. */
export function insertComposer(state: ComposerState, text: string): ComposerState {
  const inserted = Array.from(pasteText(text))
  if (inserted.length === 0) return { ...state, historyIndex: -1 }
  const characters = Array.from(state.draft)
  const at = Math.max(0, Math.min(characters.length, state.cursor))
  characters.splice(at, 0, ...inserted)
  return withDraft(state, characters, at + inserted.length)
}

export function newlineComposer(state: ComposerState): ComposerState {
  return insertComposer(state, '\n')
}

export function moveComposer(state: ComposerState, motion: ComposerMotion): ComposerState {
  const characters = Array.from(state.draft)
  const cursor = Math.max(0, Math.min(characters.length, state.cursor))
  let next: number
  switch (motion) {
    case 'left': next = cursor - 1; break
    case 'right': next = cursor + 1; break
    case 'word-left': next = wordLeft(characters, cursor); break
    case 'word-right': next = wordRight(characters, cursor); break
    case 'line-start': next = lineStart(characters, cursor); break
    case 'line-end': next = lineEnd(characters, cursor); break
    case 'up': next = verticalTarget(characters, cursor, -1); break
    case 'down': next = verticalTarget(characters, cursor, 1); break
  }
  return { ...state, cursor: Math.max(0, Math.min(characters.length, next)) }
}

export function deleteComposer(state: ComposerState, kind: ComposerDeletion): ComposerState {
  const characters = Array.from(state.draft)
  const cursor = Math.max(0, Math.min(characters.length, state.cursor))
  let start = cursor
  let end = cursor
  switch (kind) {
    case 'back-char': start = cursor - 1; break
    case 'forward-char': end = cursor + 1; break
    case 'back-word': start = wordLeft(characters, cursor); break
    case 'to-line-start': start = lineStart(characters, cursor); break
    case 'to-line-end': end = lineEnd(characters, cursor); break
  }
  start = Math.max(0, start)
  end = Math.min(characters.length, end)
  if (start >= end) return { ...state, cursor, historyIndex: -1 }
  characters.splice(start, end - start)
  return withDraft(state, characters, start)
}

/** Backwards-compatible alias for the plain backspace binding. */
export function backspaceComposer(state: ComposerState): ComposerState {
  return deleteComposer(state, 'back-char')
}

export function historyComposer(state: ComposerState, direction: -1 | 1): ComposerState {
  if (state.history.length === 0) return state
  const index = state.historyIndex === -1
    ? (direction === -1 ? state.history.length - 1 : -1)
    : Math.max(-1, Math.min(state.history.length - 1, state.historyIndex + direction))
  const draft = index === -1 ? '' : state.history[index] ?? ''
  return { ...state, historyIndex: index, draft, cursor: Array.from(draft).length }
}

export function submitComposer(state: ComposerState): { state: ComposerState; text?: string } {
  if (state.draft.trim() === '') return { state }
  const history = state.history.at(-1) === state.draft ? state.history : [...state.history, state.draft]
  return { state: { draft: '', cursor: 0, history, historyIndex: -1 }, text: state.draft }
}

/** Drop the draft without touching the history cursor's contents. */
export function clearComposer(state: ComposerState): ComposerState {
  return { ...state, draft: '', cursor: 0, historyIndex: -1 }
}

export interface CaretLine {
  /** Logical line the caret sits on, and how many the draft has. */
  readonly index: number
  readonly count: number
  /** Code-point offset of the caret within that line. */
  readonly column: number
}

/** Where the caret sits in the draft, for vertical-key routing and rendering. */
export function caretLine(state: ComposerState): CaretLine {
  const characters = Array.from(state.draft)
  const cursor = Math.max(0, Math.min(characters.length, state.cursor))
  let index = 0
  let start = 0
  for (let at = 0; at < cursor; at++) {
    if (characters[at] === '\n') {
      index++
      start = at + 1
    }
  }
  let count = 1
  for (const character of characters) if (character === '\n') count++
  return { index, count, column: cursor - start }
}
