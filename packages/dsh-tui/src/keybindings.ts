/**
 * The key literals, in one place.
 *
 * `keymap.ts` used to spell every chord inline — `ctrl(key, 'p')` for the
 * palette, `key.name === 'tab' && key.shift` for the mode cycle — and a second,
 * hand-written table described those chords for the shortcut sheet. Two copies
 * of the same fact, kept together by a drift test. That arrangement cannot
 * survive user-configurable keys at all: rebinding the palette would have to
 * edit the resolver, the sheet and the guide, and any one of them could be
 * missed.
 *
 * So the chords live here and nowhere else. The resolver asks
 * {@link Keymap.bound} whether a press is a given action; the sheet and every
 * piece of prose that names a key ask {@link Keymap.shortcut}. Rebinding an
 * action therefore changes the behaviour and the text that describes it in the
 * same move, because they are reading the same row.
 *
 * What does *not* live here is when an action applies. Whether `↑` walks the
 * history or moves the caret depends on where the caret is, and that is a
 * condition, not a chord — it stays in the resolver where it can be read.
 */

import type { KeyEvent, KeyName, UiSurface } from './keymap.ts'

/** Where a binding is offered. `global` means every surface. */
export type BindingSurface = UiSurface | 'global'

export interface Binding {
  /**
   * Stable identifier, unique across the whole table. It is what a user's
   * `keybindings.json` names, so it is part of the public surface: renaming one
   * silently unbinds whatever a user had mapped to it.
   */
  readonly action: string
  /** Canonical chords, first one is the one shown. Empty means unbound. */
  readonly chords: readonly string[]
  /** Grouping for the shortcut sheet, and the scope an override is checked in. */
  readonly surface: BindingSurface
  readonly description: string
  /**
   * Cannot be rebound or unbound. Reserved for the keys that must always reach
   * the bounded shutdown — a terminal you cannot get out of is not a terminal.
   */
  readonly reserved?: boolean
}

/** Ink never surfaces Home/End, so the readline pair carries them. */
const NAME_CHORD: Readonly<Record<KeyName, string>> = Object.freeze({
  return: 'enter',
  escape: 'escape',
  tab: 'tab',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  home: 'home',
  end: 'end',
  pageUp: 'pageup',
  pageDown: 'pagedown',
  backspace: 'backspace',
  delete: 'delete',
})

/**
 * The canonical form of one press, or `undefined` when the press is text rather
 * than a chord.
 *
 * Shift is only recorded on a named key: a shifted letter already arrives as
 * its uppercase form, so `shift+y` and `Y` would be two spellings of one press.
 */
export function chordOf(key: KeyEvent): string | undefined {
  const base = key.name !== undefined
    ? NAME_CHORD[key.name]
    // A bare CR or LF chunk is a commit that never got a name.
    : /^[\r\n]+$/.test(key.input)
      ? 'enter'
      // A space is a chord here, not text: it toggles a multi-select option.
      : key.input === ' '
        ? 'space'
        : key.input.length === 1 ? key.input.toLowerCase() : undefined
  if (base === undefined || base === '') return undefined
  const parts: string[] = []
  if (key.ctrl) parts.push('ctrl')
  // Ink reports a bare Esc with `meta` set — the escape key *is* the meta
  // prefix on this wire. Honouring that flag here would spell every Esc
  // `alt+escape` and leave the real binding permanently unmatched.
  if (key.meta && key.name !== 'escape') parts.push('alt')
  if (key.shift && key.name !== undefined) parts.push('shift')
  parts.push(base)
  return parts.join('+')
}

const DISPLAY: Readonly<Record<string, string>> = Object.freeze({
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
})

/**
 * `ctrl+p` → `Ctrl+P`, `j` → `j`.
 *
 * A lone letter is shown as it is typed, because that is how it is pressed and
 * how the guide writes it; a modified one is capitalised, because `Ctrl+p`
 * reads like a chord with a typo in it.
 */
export function formatChord(chord: string): string {
  const parts = chord.split('+')
  return parts
    .map((part, at) => DISPLAY[part]
      ?? (part.length === 1 && at > 0 ? part.toUpperCase() : part))
    .join('+')
}

/**
 * The default table.
 *
 * Order is the order the shortcut sheet lists them in, so it reads top to
 * bottom as "what you can do here" rather than alphabetically.
 */
export const DEFAULT_BINDINGS: readonly Binding[] = Object.freeze([
  {
    action: 'app:cancel',
    chords: ['ctrl+c'],
    surface: 'global',
    description: 'Arm, then run the bounded shutdown',
    reserved: true,
  },
  {
    action: 'app:escape',
    chords: ['escape'],
    surface: 'global',
    description: 'Clear the draft, then arm, then cancel the run',
    reserved: true,
  },
  { action: 'chat:submit', chords: ['enter'], surface: 'composer', description: 'Send the draft' },
  {
    action: 'chat:newline',
    chords: ['ctrl+enter', 'alt+enter'],
    surface: 'composer',
    description: 'Insert a newline instead of sending',
  },
  { action: 'caret:left', chords: ['left'], surface: 'composer', description: 'Move the caret one character left' },
  { action: 'caret:right', chords: ['right'], surface: 'composer', description: 'Move the caret one character right' },
  {
    action: 'caret:word-left',
    chords: ['ctrl+left', 'alt+left', 'alt+b'],
    surface: 'composer',
    description: 'Move the caret one word left',
  },
  {
    action: 'caret:word-right',
    chords: ['ctrl+right', 'alt+right', 'alt+f'],
    surface: 'composer',
    description: 'Move the caret one word right',
  },
  { action: 'caret:line-start', chords: ['ctrl+a'], surface: 'composer', description: 'Jump to the start of the line' },
  { action: 'caret:line-end', chords: ['ctrl+e'], surface: 'composer', description: 'Jump to the end of the line' },
  {
    action: 'edit:delete-word',
    chords: ['ctrl+w', 'alt+backspace', 'alt+delete'],
    surface: 'composer',
    description: 'Delete the word before the caret',
  },
  {
    action: 'edit:delete-to-line-start',
    chords: ['ctrl+u'],
    surface: 'composer',
    description: 'Delete to the start of the line',
  },
  {
    action: 'edit:delete-to-line-end',
    chords: ['ctrl+k'],
    surface: 'composer',
    description: 'Delete to the end of the line',
  },
  { action: 'history:previous', chords: ['up'], surface: 'composer', description: 'Walk back through the draft history' },
  { action: 'history:next', chords: ['down'], surface: 'composer', description: 'Walk forward through the draft history' },
  {
    action: 'completion:accept',
    chords: ['tab'],
    surface: 'composer',
    description: 'Accept the highlighted completion',
  },
  {
    action: 'focus:toggle',
    chords: ['tab'],
    surface: 'composer',
    description: 'Move focus between the composer and the transcript',
  },
  {
    action: 'permission:cycle',
    chords: ['shift+tab'],
    surface: 'composer',
    description: 'Cycle the permission preset',
  },
  { action: 'palette:open', chords: ['ctrl+p'], surface: 'composer', description: 'Open the command palette' },
  { action: 'session:browse', chords: ['ctrl+r'], surface: 'composer', description: 'Open the session browser' },
  { action: 'fold:toggle', chords: ['ctrl+o'], surface: 'composer', description: 'Fold or unfold the card in view' },
  {
    action: 'editor:open',
    chords: ['ctrl+x'],
    surface: 'composer',
    description: "Open that card's first location in $EDITOR",
  },
  { action: 'help:open', chords: ['?'], surface: 'composer', description: 'Show the shortcut sheet, when the draft is empty' },
  { action: 'scroll:page-up', chords: ['pageup'], surface: 'composer', description: 'Scroll the transcript up a page' },
  { action: 'scroll:page-down', chords: ['pagedown'], surface: 'composer', description: 'Scroll the transcript down a page' },
  { action: 'scroll:up', chords: ['up', 'k'], surface: 'transcript', description: 'Scroll one row up' },
  { action: 'scroll:down', chords: ['down', 'j'], surface: 'transcript', description: 'Scroll one row down' },
  {
    action: 'focus:composer',
    chords: ['enter', 'escape'],
    surface: 'transcript',
    description: 'Return to the composer',
  },
  { action: 'approval:allow', chords: ['y'], surface: 'approval', description: 'Allow the call once' },
  { action: 'approval:reject', chords: ['n'], surface: 'approval', description: 'Reject the call' },
  { action: 'approval:previous', chords: ['up'], surface: 'approval', description: 'Move up the answers' },
  { action: 'approval:next', chords: ['down'], surface: 'approval', description: 'Move down the answers' },
  { action: 'approval:confirm', chords: ['enter'], surface: 'approval', description: 'Confirm the highlighted answer' },
  {
    action: 'approval:submit-reason',
    chords: ['enter'],
    surface: 'approval-feedback',
    description: 'Reject, sending the typed reason with it',
  },
  {
    action: 'approval:cancel-reason',
    chords: ['escape'],
    surface: 'approval-feedback',
    description: 'Go back to the answers without deciding',
  },
  { action: 'question:toggle', chords: ['space'], surface: 'question', description: 'Toggle an option in a multi-select' },
  { action: 'question:previous', chords: ['up'], surface: 'question', description: 'Move the option selection up' },
  { action: 'question:next', chords: ['down'], surface: 'question', description: 'Move the option selection down' },
  { action: 'question:submit', chords: ['enter'], surface: 'question', description: 'Submit the answer' },
  { action: 'palette:previous', chords: ['up'], surface: 'palette', description: 'Move up the command list' },
  { action: 'palette:next', chords: ['down'], surface: 'palette', description: 'Move down the command list' },
  { action: 'palette:accept', chords: ['enter'], surface: 'palette', description: 'Prefill the draft with the command' },
  { action: 'palette:close', chords: ['escape'], surface: 'palette', description: 'Close the palette' },
  { action: 'browser:previous', chords: ['up'], surface: 'browser', description: 'Move the cursor up' },
  { action: 'browser:next', chords: ['down'], surface: 'browser', description: 'Move the cursor down' },
  { action: 'browser:page-up', chords: ['pageup'], surface: 'browser', description: 'Move the cursor up a page' },
  { action: 'browser:page-down', chords: ['pagedown'], surface: 'browser', description: 'Move the cursor down a page' },
  { action: 'browser:accept', chords: ['enter'], surface: 'browser', description: 'Resume the session under the cursor' },
  {
    action: 'browser:escape',
    chords: ['escape'],
    surface: 'browser',
    description: 'Clear the filter, then close the browser',
  },
])

export interface KeymapIssue {
  readonly action?: string
  readonly message: string
}

export interface Keymap {
  /** True when this press is that action. */
  bound(action: string, key: KeyEvent): boolean
  /** Display form of the first chord, e.g. `Ctrl+P`; empty when unbound. */
  shortcut(action: string): string
  /** The effective table, for the shortcut sheet. */
  bindings(): readonly Binding[]
}

function makeKeymap(bindings: readonly Binding[]): Keymap {
  const byAction = new Map(bindings.map(binding => [binding.action, binding]))
  return {
    bound(action, key) {
      const chord = chordOf(key)
      if (chord === undefined) return false
      return byAction.get(action)?.chords.includes(chord) === true
    },
    shortcut(action) {
      const first = byAction.get(action)?.chords[0]
      return first === undefined ? '' : formatChord(first)
    },
    bindings: () => bindings,
  }
}

/** The table with nothing overridden. */
export const DEFAULT_KEYMAP: Keymap = makeKeymap(DEFAULT_BINDINGS)

/**
 * One override entry: a chord, a list of them, or `null` to unbind.
 *
 * `null` is deliberately different from an empty list only in intent; both
 * leave the action unreachable. Spelling it `null` is what makes "I want this
 * key back for typing" readable in a config file.
 */
type Override = string | readonly string[] | null

function chordsOf(value: Override): readonly string[] | undefined {
  if (value === null) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
    return value as readonly string[]
  }
  return undefined
}

/** A chord a user could plausibly have typed; anything else is a typo. */
const CHORD_PATTERN = /^(ctrl\+|alt\+|shift\+)*[a-z0-9?/.,;'`\-=[\]\\]$|^(ctrl\+|alt\+|shift\+)*(enter|escape|tab|up|down|left|right|home|end|pageup|pagedown|backspace|delete|space)$/

/**
 * Merge user overrides onto the defaults.
 *
 * Every problem is reported and then skipped rather than thrown: a typo in a
 * config file must not stop the terminal from starting, because the terminal is
 * how you would fix the typo.
 */
export function buildKeymap(
  overrides: unknown,
  defaults: readonly Binding[] = DEFAULT_BINDINGS,
): { keymap: Keymap; issues: readonly KeymapIssue[] } {
  const issues: KeymapIssue[] = []
  if (overrides === undefined || overrides === null) {
    return { keymap: makeKeymap(defaults), issues }
  }
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    return {
      keymap: makeKeymap(defaults),
      issues: [{ message: 'keybindings must be an object of action → chord' }],
    }
  }
  const known = new Map(defaults.map(binding => [binding.action, binding]))
  const applied = new Map<string, readonly string[]>()
  for (const [action, value] of Object.entries(overrides as Record<string, Override>)) {
    const binding = known.get(action)
    if (binding === undefined) {
      issues.push({ action, message: `unknown action "${action}"` })
      continue
    }
    if (binding.reserved === true) {
      issues.push({
        action,
        message: `"${action}" is reserved (${binding.chords.join(', ')}) and cannot be rebound`,
      })
      continue
    }
    const chords = chordsOf(value)
    if (chords === undefined) {
      issues.push({ action, message: `"${action}" must map to a chord, a list of chords, or null` })
      continue
    }
    const bad = chords.filter(chord => !CHORD_PATTERN.test(chord))
    if (bad.length > 0) {
      issues.push({ action, message: `"${action}" has unreadable chords: ${bad.join(', ')}` })
      continue
    }
    applied.set(action, chords)
  }
  const merged = defaults.map(binding => applied.has(binding.action)
    ? { ...binding, chords: applied.get(binding.action) as readonly string[] }
    : binding)
  // A chord that now means two things on one surface is reported, not resolved:
  // which one wins is an implementation detail nobody should have to know.
  //
  // Only ambiguities the *user* introduced are reported. Some chords are shared
  // on purpose — Tab accepts a completion while the list is open and moves focus
  // when it is not — and telling someone their config broke something they never
  // touched is worse than saying nothing.
  const seen = new Map<string, string>()
  for (const binding of merged) {
    for (const chord of binding.chords) {
      const key = `${binding.surface}|${chord}`
      const owner = seen.get(key)
      if (owner !== undefined && owner !== binding.action
        && (applied.has(binding.action) || applied.has(owner))) {
        issues.push({
          action: binding.action,
          message: `${formatChord(chord)} is bound to both "${owner}" and "${binding.action}"`,
        })
      }
      seen.set(key, binding.action)
    }
  }
  return { keymap: makeKeymap(merged), issues }
}

/**
 * Read a `keybindings.json` body.
 *
 * Total by construction: unreadable JSON is one issue and the defaults, never a
 * throw. The terminal is how a user would fix the file, so it has to start.
 */
export function parseKeybindings(
  contents: string,
): { keymap: Keymap; issues: readonly KeymapIssue[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch (error) {
    return {
      keymap: DEFAULT_KEYMAP,
      issues: [{ message: `keybindings.json is not valid JSON: ${String(error)}` }],
    }
  }
  return buildKeymap(parsed)
}

/** One line summarising what was wrong with a user's overrides. */
export function describeIssues(issues: readonly KeymapIssue[]): string | undefined {
  if (issues.length === 0) return undefined
  const [first] = issues
  const rest = issues.length - 1
  return `keybindings.json: ${first?.message ?? ''}${rest > 0 ? ` (+${String(rest)} more)` : ''}`
}
