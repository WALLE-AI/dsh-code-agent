/**
 * Key binding table and pure resolver.
 *
 * The Ink layer only translates a raw keypress into a {@link KeyEvent} and
 * paints whatever the resolved {@link UiAction} produced. Every binding decision
 * lives here so it can be unit tested without a terminal, and so the help
 * overlay, the user guide and the shell completions can be generated from — or
 * drift-tested against — one table.
 */

import type { ComposerDeletion, ComposerMotion } from './composer.ts'

export type KeyName =
  | 'return' | 'escape' | 'tab' | 'up' | 'down' | 'left' | 'right'
  | 'home' | 'end' | 'pageUp' | 'pageDown' | 'backspace' | 'delete'

export interface KeyEvent {
  /** Printable text of the press; empty for pure control keys. */
  readonly input: string
  readonly ctrl: boolean
  readonly meta: boolean
  readonly shift: boolean
  readonly name?: KeyName
}

/**
 * The surface that owns the keyboard. Exactly one is active per frame; the
 * caller decides which, mirroring the modal precedence of the frame itself.
 */
export type UiSurface =
  | 'approval' | 'approval-feedback' | 'question' | 'palette' | 'help' | 'browser'
  | 'transcript' | 'composer'

export type UiAction =
  // Global
  | { readonly kind: 'cancel-arm' }
  | { readonly kind: 'cancel' }
  // Approval
  /** Answer with the first row of this outcome that settles on its own. */
  | { readonly kind: 'approval-shortcut'; readonly allowed: boolean }
  /** Answer with the row at this index, whatever it asks for next. */
  | { readonly kind: 'approval-select'; readonly index: number }
  | { readonly kind: 'approval-move'; readonly delta: -1 | 1 }
  | { readonly kind: 'approval-confirm' }
  // Approval, while a rejection reason is being typed
  | { readonly kind: 'approval-feedback-type'; readonly text: string }
  | { readonly kind: 'approval-feedback-backspace' }
  | { readonly kind: 'approval-feedback-submit' }
  | { readonly kind: 'approval-feedback-cancel' }
  // Question form
  | { readonly kind: 'question-move'; readonly delta: -1 | 1 }
  | { readonly kind: 'question-backspace' }
  | { readonly kind: 'question-choose'; readonly index: number }
  | { readonly kind: 'question-toggle' }
  | { readonly kind: 'question-submit' }
  | { readonly kind: 'question-type'; readonly text: string }
  // Command palette
  | { readonly kind: 'palette-close' }
  | { readonly kind: 'palette-move'; readonly delta: -1 | 1 }
  | { readonly kind: 'palette-backspace' }
  | { readonly kind: 'palette-accept' }
  | { readonly kind: 'palette-type'; readonly text: string }
  // Non-modal
  | { readonly kind: 'open-palette' }
  | { readonly kind: 'open-picker' }
  | { readonly kind: 'open-help' }
  | { readonly kind: 'close-help' }
  | { readonly kind: 'cycle-mode' }
  // Session browser
  | { readonly kind: 'browser-move'; readonly delta: -1 | 1 }
  | { readonly kind: 'browser-page'; readonly delta: -1 | 1 }
  | { readonly kind: 'browser-type'; readonly text: string }
  | { readonly kind: 'browser-backspace' }
  | { readonly kind: 'browser-accept' }
  | { readonly kind: 'browser-escape' }
  | { readonly kind: 'toggle-focus' }
  | { readonly kind: 'focus-composer' }
  | { readonly kind: 'scroll'; readonly direction: -1 | 1; readonly page: boolean }
  | { readonly kind: 'toggle-fold' }
  | { readonly kind: 'open-editor' }
  // Draft completion
  | { readonly kind: 'completion-accept' }
  | { readonly kind: 'completion-move'; readonly delta: -1 | 1 }
  | { readonly kind: 'completion-dismiss' }
  // Composer
  | { readonly kind: 'history'; readonly delta: -1 | 1 }
  | { readonly kind: 'composer-newline' }
  | { readonly kind: 'composer-move'; readonly motion: ComposerMotion }
  | { readonly kind: 'composer-delete'; readonly deletion: ComposerDeletion }
  | { readonly kind: 'composer-clear' }
  | { readonly kind: 'submit' }
  | { readonly kind: 'composer-insert'; readonly text: string }

export interface KeyContext {
  /** The composer accepts input only in an interactive session. */
  readonly interactive: boolean
  /** A second Esc or Ctrl+C is already armed. */
  readonly cancelArmed: boolean
  /** The focused question exposes selectable options. */
  readonly questionHasOptions: boolean
  /** How many answers the approval panel is showing. */
  readonly approvalOptionCount: number
  /** The draft is empty, so Esc has nothing to clear. */
  readonly draftEmpty: boolean
  /** The caret has a draft line above it, so `↑` is a motion and not history. */
  readonly canMoveUp: boolean
  /** The caret has a draft line below it, so `↓` is a motion and not history. */
  readonly canMoveDown: boolean
  /** A completion list is showing candidates for the token at the caret. */
  readonly completionOpen: boolean
  /** The token already spells the selected candidate, so accepting is a no-op. */
  readonly completionExact: boolean
}

/** True when this press means "commit", including a bare CR/LF chunk. */
export function isReturn(key: KeyEvent): boolean {
  return key.name === 'return' || /^[\r\n]+$/.test(key.input)
}

/**
 * True for a commit with no modifier held. Destructive confirmations require it
 * so that Ctrl+Enter or Option+Enter cannot answer them by accident.
 */
export function isPlainReturn(key: KeyEvent): boolean {
  return isReturn(key) && !key.ctrl && !key.meta && !key.shift
}

/** True when the press carries text the composer or a filter should absorb. */
function isPrintable(key: KeyEvent): boolean {
  return !key.ctrl && !key.meta && key.input !== ''
}

function ctrl(key: KeyEvent, letter: string): boolean {
  return key.ctrl && key.input === letter
}

/**
 * Resolve one press against the surface that owns the keyboard.
 *
 * `undefined` means the press is deliberately swallowed: a modal never lets a
 * key it does not understand fall through to the composer.
 */
export function resolveKey(
  surface: UiSurface,
  key: KeyEvent,
  context: KeyContext,
): UiAction | undefined {
  // Ctrl+C outranks every surface: it is the one key that always reaches the
  // bounded shutdown.
  if (ctrl(key, 'c')) return context.cancelArmed ? { kind: 'cancel' } : { kind: 'cancel-arm' }

  switch (surface) {
    case 'approval': return approvalKey(key, context)
    case 'approval-feedback': return approvalFeedbackKey(key)
    case 'question': return questionKey(key, context)
    case 'palette': return paletteKey(key)
    // Any key dismisses the help sheet; it is a reference card, not a mode.
    case 'help': return { kind: 'close-help' }
    case 'browser': return browserKey(key)
    default: return openKey(surface, key, context)
  }
}

function approvalKey(key: KeyEvent, context: KeyContext): UiAction | undefined {
  // The letter answers stay, and stay meaning what they always meant: `y`
  // allows once and `n` rejects now, whatever else the list has grown. Neither
  // ever lands on a row that would then ask for something.
  if (key.input.toLowerCase() === 'y') return { kind: 'approval-shortcut', allowed: true }
  if (key.input.toLowerCase() === 'n') return { kind: 'approval-shortcut', allowed: false }
  // Digits address the list by position, so the row a user reads as `3` is the
  // row `3` answers with — including the ones that ask for a reason.
  const digit = /^[1-9]$/.test(key.input) ? Number(key.input) - 1 : undefined
  if (digit !== undefined) {
    return digit < context.approvalOptionCount
      ? { kind: 'approval-select', index: digit }
      : undefined
  }
  // Esc fails closed, which is what the queue does when it cannot ask at all.
  if (key.name === 'escape') return { kind: 'approval-shortcut', allowed: false }
  if (key.name === 'up') return { kind: 'approval-move', delta: -1 }
  if (key.name === 'down') return { kind: 'approval-move', delta: 1 }
  // Only a bare Enter confirms: a modifier held over from the previous keystroke
  // must not be able to answer a prompt that gates a tool run.
  if (isPlainReturn(key)) return { kind: 'approval-confirm' }
  return undefined
}

/**
 * Typing the reason a call was refused.
 *
 * Esc peels one layer here rather than answering: the prompt is still open, and
 * a user who opened the field by mistake must be able to get back to the list
 * without having answered anything. The fail-closed Esc is the one on the list.
 */
function approvalFeedbackKey(key: KeyEvent): UiAction | undefined {
  if (key.name === 'escape') return { kind: 'approval-feedback-cancel' }
  if (key.name === 'backspace' || key.name === 'delete') {
    return { kind: 'approval-feedback-backspace' }
  }
  if (isPlainReturn(key)) return { kind: 'approval-feedback-submit' }
  if (isPrintable(key)) return { kind: 'approval-feedback-type', text: key.input }
  return undefined
}

function questionKey(key: KeyEvent, context: KeyContext): UiAction | undefined {
  if (key.name === 'up') return { kind: 'question-move', delta: -1 }
  if (key.name === 'down') return { kind: 'question-move', delta: 1 }
  if (key.name === 'backspace' || key.name === 'delete') return { kind: 'question-backspace' }
  if (/^[1-9]$/.test(key.input)) return { kind: 'question-choose', index: Number(key.input) - 1 }
  if (key.input === ' ' && context.questionHasOptions) return { kind: 'question-toggle' }
  if (isReturn(key)) return { kind: 'question-submit' }
  if (isPrintable(key)) return { kind: 'question-type', text: key.input }
  return undefined
}

function paletteKey(key: KeyEvent): UiAction | undefined {
  if (key.name === 'escape') return { kind: 'palette-close' }
  if (key.name === 'up') return { kind: 'palette-move', delta: -1 }
  if (key.name === 'down') return { kind: 'palette-move', delta: 1 }
  if (key.name === 'backspace' || key.name === 'delete') return { kind: 'palette-backspace' }
  if (isReturn(key)) return { kind: 'palette-accept' }
  if (isPrintable(key)) return { kind: 'palette-type', text: key.input }
  return undefined
}

function browserKey(key: KeyEvent): UiAction | undefined {
  if (key.name === 'escape') return { kind: 'browser-escape' }
  if (key.name === 'up') return { kind: 'browser-move', delta: -1 }
  if (key.name === 'down') return { kind: 'browser-move', delta: 1 }
  if (key.name === 'pageUp') return { kind: 'browser-page', delta: -1 }
  if (key.name === 'pageDown') return { kind: 'browser-page', delta: 1 }
  if (key.name === 'backspace' || key.name === 'delete') return { kind: 'browser-backspace' }
  if (isPlainReturn(key)) return { kind: 'browser-accept' }
  // Everything else is the query: the list is the search result, so there is no
  // mode to enter first.
  if (isPrintable(key)) return { kind: 'browser-type', text: key.input }
  return undefined
}

/** The composer and the transcript share one non-modal cascade. */
function openKey(
  surface: 'transcript' | 'composer',
  key: KeyEvent,
  context: KeyContext,
): UiAction | undefined {
  if (ctrl(key, 'p')) return context.interactive ? { kind: 'open-palette' } : undefined
  if (ctrl(key, 'r')) return context.interactive ? { kind: 'open-picker' } : undefined

  // An open completion list owns Tab, the vertical keys and Esc; it is the
  // innermost layer, so it is also the first one Esc peels off.
  if (surface === 'composer' && context.completionOpen) {
    if (key.name === 'tab') return { kind: 'completion-accept' }
    // Enter accepts only while there is something left to complete. Once the
    // token already spells the candidate, Enter must send — otherwise typing a
    // whole command name would need two presses to run it.
    if (isReturn(key) && !context.completionExact) return { kind: 'completion-accept' }
    if (key.name === 'up') return { kind: 'completion-move', delta: -1 }
    if (key.name === 'down') return { kind: 'completion-move', delta: 1 }
    if (key.name === 'escape') return { kind: 'completion-dismiss' }
  }

  // Shift+Tab must be tested before plain Tab: a backtab parses as tab+shift.
  if (key.name === 'tab' && key.shift) return { kind: 'cycle-mode' }
  if (key.name === 'tab') return { kind: 'toggle-focus' }
  // `?` is only a help request when it cannot be part of a message.
  if (key.input === '?' && surface === 'composer' && context.draftEmpty) {
    return { kind: 'open-help' }
  }

  if (surface === 'transcript') {
    if (key.name === 'up' || key.input === 'k') return { kind: 'scroll', direction: -1, page: false }
    if (key.name === 'down' || key.input === 'j') return { kind: 'scroll', direction: 1, page: false }
    if (isReturn(key) || key.name === 'escape') return { kind: 'focus-composer' }
  }

  // Graded Esc: each press peels exactly one layer. A non-empty draft is the
  // first thing to go, so Esc never cancels a run the user was still typing to.
  if (key.name === 'escape') {
    if (surface === 'composer' && context.interactive && !context.draftEmpty) {
      return { kind: 'composer-clear' }
    }
    return context.cancelArmed ? { kind: 'cancel' } : { kind: 'cancel-arm' }
  }
  if (ctrl(key, 'o')) return { kind: 'toggle-fold' }
  if (ctrl(key, 'x')) return { kind: 'open-editor' }
  if (key.name === 'pageUp') return { kind: 'scroll', direction: -1, page: true }
  if (key.name === 'pageDown') return { kind: 'scroll', direction: 1, page: true }

  if (!context.interactive || surface === 'transcript') return undefined

  // Caret motion. Ink 5 never surfaces Home/End (`parse-keypress` resolves them
  // to a name that `useInput` blanks out), so the readline pair carries them.
  if (key.name === 'left') {
    return { kind: 'composer-move', motion: key.ctrl || key.meta ? 'word-left' : 'left' }
  }
  if (key.name === 'right') {
    return { kind: 'composer-move', motion: key.ctrl || key.meta ? 'word-right' : 'right' }
  }
  if (key.meta && key.input === 'b') return { kind: 'composer-move', motion: 'word-left' }
  if (key.meta && key.input === 'f') return { kind: 'composer-move', motion: 'word-right' }
  if (ctrl(key, 'a')) return { kind: 'composer-move', motion: 'line-start' }
  if (ctrl(key, 'e')) return { kind: 'composer-move', motion: 'line-end' }

  // Deletion. Ink reports the physical Backspace key (DEL, 0x7f) as `delete`,
  // so the two flags are one key here; Alt+Backspace is the word kill.
  if (key.name === 'backspace' || key.name === 'delete') {
    return { kind: 'composer-delete', deletion: key.meta ? 'back-word' : 'back-char' }
  }
  if (ctrl(key, 'w')) return { kind: 'composer-delete', deletion: 'back-word' }
  if (ctrl(key, 'u')) return { kind: 'composer-delete', deletion: 'to-line-start' }
  if (ctrl(key, 'k')) return { kind: 'composer-delete', deletion: 'to-line-end' }

  // A multi-line draft owns the vertical keys; history takes them at the edges.
  if (key.name === 'up') {
    return context.canMoveUp ? { kind: 'composer-move', motion: 'up' } : { kind: 'history', delta: -1 }
  }
  if (key.name === 'down') {
    return context.canMoveDown ? { kind: 'composer-move', motion: 'down' } : { kind: 'history', delta: 1 }
  }

  if (isReturn(key) && (key.ctrl || key.meta)) return { kind: 'composer-newline' }
  if (isReturn(key)) return { kind: 'submit' }
  if (isPrintable(key)) return { kind: 'composer-insert', text: key.input }
  return undefined
}

/** The structural shape of Ink's key record; typed here to keep Ink out of the core. */
export interface InkKeyLike {
  readonly upArrow: boolean
  readonly downArrow: boolean
  readonly leftArrow: boolean
  readonly rightArrow: boolean
  readonly pageDown: boolean
  readonly pageUp: boolean
  readonly return: boolean
  readonly escape: boolean
  readonly ctrl: boolean
  readonly shift: boolean
  readonly tab: boolean
  readonly backspace: boolean
  readonly delete: boolean
  readonly meta: boolean
}

function nameOf(key: InkKeyLike): KeyName | undefined {
  if (key.return) return 'return'
  if (key.escape) return 'escape'
  if (key.tab) return 'tab'
  if (key.upArrow) return 'up'
  if (key.downArrow) return 'down'
  if (key.leftArrow) return 'left'
  if (key.rightArrow) return 'right'
  if (key.pageUp) return 'pageUp'
  if (key.pageDown) return 'pageDown'
  if (key.backspace) return 'backspace'
  if (key.delete) return 'delete'
  return undefined
}

/** Translate one Ink keypress into the renderer-independent {@link KeyEvent}. */
export function fromInkKey(input: string, key: InkKeyLike): KeyEvent {
  const name = nameOf(key)
  return {
    input,
    ctrl: key.ctrl,
    meta: key.meta,
    shift: key.shift,
    ...(name === undefined ? {} : { name }),
  }
}

export interface KeyBindingDoc {
  readonly keys: string
  readonly surface: UiSurface | 'global'
  readonly description: string
}

/**
 * The documented binding table. It is descriptive, not executable: the resolver
 * above is the behaviour, and a drift test keeps the two in step.
 */
export const KEY_BINDINGS: readonly KeyBindingDoc[] = Object.freeze([
  { keys: 'Ctrl+C', surface: 'global', description: 'Arm, then run the bounded shutdown' },
  { keys: 'Esc', surface: 'global', description: 'Clear the draft, then arm, then cancel the run' },
  { keys: 'Enter', surface: 'composer', description: 'Send the draft' },
  { keys: 'Ctrl+Enter', surface: 'composer', description: 'Insert a newline instead of sending' },
  { keys: '← / →', surface: 'composer', description: 'Move the caret one character' },
  { keys: 'Ctrl+← / Ctrl+→', surface: 'composer', description: 'Move the caret one word' },
  { keys: 'Ctrl+A / Ctrl+E', surface: 'composer', description: 'Jump to the start or end of the line' },
  { keys: 'Ctrl+W', surface: 'composer', description: 'Delete the word before the caret' },
  { keys: 'Ctrl+U / Ctrl+K', surface: 'composer', description: 'Delete to the start or end of the line' },
  { keys: '↑ / ↓', surface: 'composer', description: 'Move between draft lines, then walk the history' },
  { keys: 'Tab', surface: 'composer', description: 'Accept the completion, or move focus between the composer and the transcript' },
  { keys: '/', surface: 'composer', description: 'Complete a command name at the start of the draft' },
  { keys: '@', surface: 'composer', description: 'Complete a workspace path anywhere in the draft' },
  { keys: '?', surface: 'composer', description: 'Show the shortcut sheet, when the draft is empty' },
  { keys: 'Shift+Tab', surface: 'composer', description: 'Cycle the permission mode' },
  { keys: 'Ctrl+P', surface: 'composer', description: 'Open the command palette' },
  { keys: 'Ctrl+R', surface: 'composer', description: 'Open the session browser' },
  { keys: 'Ctrl+O', surface: 'composer', description: 'Fold or unfold the tool card in view' },
  { keys: 'Ctrl+X', surface: 'composer', description: "Open that card's first location in $EDITOR" },
  { keys: 'PgUp / PgDn', surface: 'composer', description: 'Scroll the transcript by a page' },
  { keys: 'j / k', surface: 'transcript', description: 'Scroll one row, as do ↑ and ↓' },
  { keys: 'Enter / Esc', surface: 'transcript', description: 'Return to the composer' },
  { keys: 'y', surface: 'approval', description: 'Allow the call once' },
  { keys: 'n', surface: 'approval', description: 'Reject the call' },
  { keys: '1–9', surface: 'approval', description: 'Answer with that row, including the ones that ask for more' },
  { keys: 'Esc', surface: 'approval', description: 'Reject the call, failing closed' },
  { keys: '↑ / ↓', surface: 'approval', description: 'Move between the answers' },
  { keys: 'Enter', surface: 'approval', description: 'Confirm the highlighted answer' },
  { keys: 'Enter', surface: 'approval-feedback', description: 'Reject, sending the typed reason with it' },
  { keys: 'Esc', surface: 'approval-feedback', description: 'Go back to the answers without deciding' },
  { keys: '1–9', surface: 'question', description: 'Pick an option by index' },
  { keys: 'Space', surface: 'question', description: 'Toggle an option in a multi-select' },
  { keys: '↑ / ↓', surface: 'question', description: 'Move the option selection' },
  { keys: '↑ / ↓, Enter, Esc', surface: 'palette', description: 'Select, prefill the draft, close' },
  { keys: 'type to filter', surface: 'browser', description: 'The list is the search result; there is no mode to enter' },
  { keys: '↑ / ↓, PgUp / PgDn', surface: 'browser', description: 'Move the cursor' },
  { keys: 'Enter', surface: 'browser', description: 'Resume the session under the cursor' },
  { keys: 'Esc', surface: 'browser', description: 'Clear the filter, then close the browser' },
])
