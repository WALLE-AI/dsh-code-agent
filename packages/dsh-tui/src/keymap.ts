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
import { DEFAULT_KEYMAP, formatChord, type Keymap } from './keybindings.ts'

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
  keys: Keymap = DEFAULT_KEYMAP,
): UiAction | undefined {
  // Ctrl+C outranks every surface: it is the one key that always reaches the
  // bounded shutdown, which is why it is reserved from rebinding.
  if (keys.bound('app:cancel', key)) {
    return context.cancelArmed ? { kind: 'cancel' } : { kind: 'cancel-arm' }
  }

  switch (surface) {
    case 'approval': return approvalKey(key, context, keys)
    case 'approval-feedback': return approvalFeedbackKey(key, keys)
    case 'question': return questionKey(key, context, keys)
    case 'palette': return paletteKey(key, keys)
    // Any key dismisses the help sheet; it is a reference card, not a mode.
    case 'help': return { kind: 'close-help' }
    case 'browser': return browserKey(key, keys)
    default: return openKey(surface, key, context, keys)
  }
}

function approvalKey(key: KeyEvent, context: KeyContext, keys: Keymap): UiAction | undefined {
  // The letter answers stay, and stay meaning what they always meant: `y`
  // allows once and `n` rejects now, whatever else the list has grown. Neither
  // ever lands on a row that would then ask for something.
  if (keys.bound('approval:allow', key)) return { kind: 'approval-shortcut', allowed: true }
  if (keys.bound('approval:reject', key)) return { kind: 'approval-shortcut', allowed: false }
  // Digits address the list by position, so the row a user reads as `3` is the
  // row `3` answers with — including the ones that ask for a reason.
  const digit = /^[1-9]$/.test(key.input) ? Number(key.input) - 1 : undefined
  if (digit !== undefined) {
    return digit < context.approvalOptionCount
      ? { kind: 'approval-select', index: digit }
      : undefined
  }
  // Esc fails closed, which is what the queue does when it cannot ask at all.
  if (keys.bound('app:escape', key)) return { kind: 'approval-shortcut', allowed: false }
  if (keys.bound('approval:previous', key)) return { kind: 'approval-move', delta: -1 }
  if (keys.bound('approval:next', key)) return { kind: 'approval-move', delta: 1 }
  // Only a bare Enter confirms: a modifier held over from the previous keystroke
  // must not be able to answer a prompt that gates a tool run.
  if (keys.bound('approval:confirm', key) && isPlainReturn(key)) return { kind: 'approval-confirm' }
  return undefined
}

/**
 * Typing the reason a call was refused.
 *
 * Esc peels one layer here rather than answering: the prompt is still open, and
 * a user who opened the field by mistake must be able to get back to the list
 * without having answered anything. The fail-closed Esc is the one on the list.
 */
function approvalFeedbackKey(key: KeyEvent, keys: Keymap): UiAction | undefined {
  if (keys.bound('approval:cancel-reason', key)) return { kind: 'approval-feedback-cancel' }
  if (key.name === 'backspace' || key.name === 'delete') {
    return { kind: 'approval-feedback-backspace' }
  }
  if (keys.bound('approval:submit-reason', key) && isPlainReturn(key)) {
    return { kind: 'approval-feedback-submit' }
  }
  if (isPrintable(key)) return { kind: 'approval-feedback-type', text: key.input }
  return undefined
}

function questionKey(key: KeyEvent, context: KeyContext, keys: Keymap): UiAction | undefined {
  if (keys.bound('question:previous', key)) return { kind: 'question-move', delta: -1 }
  if (keys.bound('question:next', key)) return { kind: 'question-move', delta: 1 }
  if (key.name === 'backspace' || key.name === 'delete') return { kind: 'question-backspace' }
  if (/^[1-9]$/.test(key.input)) return { kind: 'question-choose', index: Number(key.input) - 1 }
  if (keys.bound('question:toggle', key) && context.questionHasOptions) {
    return { kind: 'question-toggle' }
  }
  if (keys.bound('question:submit', key) && isReturn(key)) return { kind: 'question-submit' }
  if (isPrintable(key)) return { kind: 'question-type', text: key.input }
  return undefined
}

function paletteKey(key: KeyEvent, keys: Keymap): UiAction | undefined {
  if (keys.bound('palette:close', key)) return { kind: 'palette-close' }
  if (keys.bound('palette:previous', key)) return { kind: 'palette-move', delta: -1 }
  if (keys.bound('palette:next', key)) return { kind: 'palette-move', delta: 1 }
  if (key.name === 'backspace' || key.name === 'delete') return { kind: 'palette-backspace' }
  if (keys.bound('palette:accept', key) && isReturn(key)) return { kind: 'palette-accept' }
  if (isPrintable(key)) return { kind: 'palette-type', text: key.input }
  return undefined
}

function browserKey(key: KeyEvent, keys: Keymap): UiAction | undefined {
  if (keys.bound('browser:escape', key)) return { kind: 'browser-escape' }
  if (keys.bound('browser:previous', key)) return { kind: 'browser-move', delta: -1 }
  if (keys.bound('browser:next', key)) return { kind: 'browser-move', delta: 1 }
  if (keys.bound('browser:page-up', key)) return { kind: 'browser-page', delta: -1 }
  if (keys.bound('browser:page-down', key)) return { kind: 'browser-page', delta: 1 }
  if (key.name === 'backspace' || key.name === 'delete') return { kind: 'browser-backspace' }
  if (keys.bound('browser:accept', key) && isPlainReturn(key)) return { kind: 'browser-accept' }
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
  keys: Keymap,
): UiAction | undefined {
  if (keys.bound('palette:open', key)) {
    return context.interactive ? { kind: 'open-palette' } : undefined
  }
  if (keys.bound('session:browse', key)) {
    return context.interactive ? { kind: 'open-picker' } : undefined
  }

  // An open completion list owns Tab, the vertical keys and Esc; it is the
  // innermost layer, so it is also the first one Esc peels off. This is the
  // context stack in the one place the profile actually has one: the same
  // chords mean different things depending on which layer is showing, and the
  // innermost layer is asked first.
  if (surface === 'composer' && context.completionOpen) {
    if (keys.bound('completion:accept', key)) return { kind: 'completion-accept' }
    // Enter accepts only while there is something left to complete. Once the
    // token already spells the candidate, Enter must send — otherwise typing a
    // whole command name would need two presses to run it.
    if (isReturn(key) && !context.completionExact) return { kind: 'completion-accept' }
    if (keys.bound('history:previous', key)) return { kind: 'completion-move', delta: -1 }
    if (keys.bound('history:next', key)) return { kind: 'completion-move', delta: 1 }
    if (keys.bound('app:escape', key)) return { kind: 'completion-dismiss' }
  }

  // The mode cycle must be tested before plain Tab: a backtab parses as
  // tab+shift, so the more specific chord has to be offered the press first.
  if (keys.bound('permission:cycle', key)) return { kind: 'cycle-mode' }
  if (keys.bound('focus:toggle', key) && !key.shift) return { kind: 'toggle-focus' }
  // `?` is only a help request when it cannot be part of a message.
  if (keys.bound('help:open', key) && surface === 'composer' && context.draftEmpty) {
    return { kind: 'open-help' }
  }

  if (surface === 'transcript') {
    if (keys.bound('scroll:up', key)) return { kind: 'scroll', direction: -1, page: false }
    if (keys.bound('scroll:down', key)) return { kind: 'scroll', direction: 1, page: false }
    if (keys.bound('focus:composer', key)) return { kind: 'focus-composer' }
  }

  // Graded Esc: each press peels exactly one layer. A non-empty draft is the
  // first thing to go, so Esc never cancels a run the user was still typing to.
  if (keys.bound('app:escape', key)) {
    if (surface === 'composer' && context.interactive && !context.draftEmpty) {
      return { kind: 'composer-clear' }
    }
    return context.cancelArmed ? { kind: 'cancel' } : { kind: 'cancel-arm' }
  }
  if (keys.bound('fold:toggle', key)) return { kind: 'toggle-fold' }
  if (keys.bound('editor:open', key)) return { kind: 'open-editor' }
  if (keys.bound('scroll:page-up', key)) return { kind: 'scroll', direction: -1, page: true }
  if (keys.bound('scroll:page-down', key)) return { kind: 'scroll', direction: 1, page: true }

  if (!context.interactive || surface === 'transcript') return undefined

  // Caret motion. Ink 5 never surfaces Home/End (`parse-keypress` resolves them
  // to a name that `useInput` blanks out), so the readline pair carries them.
  // The word chords are offered first because they are the more specific press:
  // `ctrl+left` would otherwise be swallowed by the plain `left` binding.
  if (keys.bound('caret:word-left', key)) return { kind: 'composer-move', motion: 'word-left' }
  if (keys.bound('caret:word-right', key)) return { kind: 'composer-move', motion: 'word-right' }
  if (keys.bound('caret:left', key)) return { kind: 'composer-move', motion: 'left' }
  if (keys.bound('caret:right', key)) return { kind: 'composer-move', motion: 'right' }
  if (keys.bound('caret:line-start', key)) return { kind: 'composer-move', motion: 'line-start' }
  if (keys.bound('caret:line-end', key)) return { kind: 'composer-move', motion: 'line-end' }

  // Deletion. Ink reports the physical Backspace key (DEL, 0x7f) as `delete`,
  // so the two flags are one key here.
  if (keys.bound('edit:delete-word', key)) return { kind: 'composer-delete', deletion: 'back-word' }
  if (key.name === 'backspace' || key.name === 'delete') {
    return { kind: 'composer-delete', deletion: 'back-char' }
  }
  if (keys.bound('edit:delete-to-line-start', key)) {
    return { kind: 'composer-delete', deletion: 'to-line-start' }
  }
  if (keys.bound('edit:delete-to-line-end', key)) {
    return { kind: 'composer-delete', deletion: 'to-line-end' }
  }

  // A multi-line draft owns the vertical keys; history takes them at the edges.
  if (keys.bound('history:previous', key)) {
    return context.canMoveUp ? { kind: 'composer-move', motion: 'up' } : { kind: 'history', delta: -1 }
  }
  if (keys.bound('history:next', key)) {
    return context.canMoveDown ? { kind: 'composer-move', motion: 'down' } : { kind: 'history', delta: 1 }
  }

  if (keys.bound('chat:newline', key)) return { kind: 'composer-newline' }
  if (keys.bound('chat:submit', key) && isReturn(key)) return { kind: 'submit' }
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
 * The shortcut sheet's rows.
 *
 * Derived from the effective keymap rather than written out again: the sheet
 * and the resolver read the same row, so a rebound key changes both in one
 * move. This is what replaced the hand-written copy and the drift test that
 * kept the two honest.
 */
export function keyBindingDocs(keys: Keymap = DEFAULT_KEYMAP): readonly KeyBindingDoc[] {
  return keys.bindings()
    .filter(binding => binding.chords.length > 0)
    .map(binding => ({
      keys: binding.chords.map(formatChord).join(' / '),
      surface: binding.surface,
      description: binding.description,
    }))
}

/** The default sheet, for callers with no user overrides to honour. */
export const KEY_BINDINGS: readonly KeyBindingDoc[] = Object.freeze(keyBindingDocs())
