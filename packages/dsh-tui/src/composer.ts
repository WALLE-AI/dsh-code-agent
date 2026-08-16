export interface ComposerState {
  readonly draft: string
  readonly history: readonly string[]
  readonly historyIndex: number
}

export const emptyComposer: ComposerState = Object.freeze({ draft: '', history: [], historyIndex: -1 })

// Ink strips a leading ESC from every chunk, so the opening bracketed-paste
// marker can arrive without it. Both markers are removed wherever they occur:
// a long paste may also be split across chunks.
const PASTE_MARKER = new RegExp(`${String.fromCharCode(27)}?${String.raw`\[20[01]~`}`, 'g')

function pasteText(text: string): string {
  return text.replace(PASTE_MARKER, '')
}

export function insertComposer(state: ComposerState, text: string): ComposerState {
  return { ...state, draft: state.draft + pasteText(text), historyIndex: -1 }
}

export function newlineComposer(state: ComposerState): ComposerState {
  return insertComposer(state, '\n')
}

export function backspaceComposer(state: ComposerState): ComposerState {
  const characters = Array.from(state.draft)
  characters.pop()
  return { ...state, draft: characters.join(''), historyIndex: -1 }
}

export function historyComposer(state: ComposerState, direction: -1 | 1): ComposerState {
  if (state.history.length === 0) return state
  const index = state.historyIndex === -1
    ? (direction === -1 ? state.history.length - 1 : -1)
    : Math.max(-1, Math.min(state.history.length - 1, state.historyIndex + direction))
  return { ...state, historyIndex: index, draft: index === -1 ? '' : state.history[index] ?? '' }
}

export function submitComposer(state: ComposerState): { state: ComposerState; text?: string } {
  if (state.draft.trim() === '') return { state }
  const history = state.history.at(-1) === state.draft ? state.history : [...state.history, state.draft]
  return { state: { draft: '', history, historyIndex: -1 }, text: state.draft }
}
