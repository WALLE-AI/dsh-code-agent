/**
 * Draft completion: slash commands and `@` file mentions.
 *
 * Both work off the caret, not the start of the draft, so a mention can sit
 * mid-sentence. Accepting a candidate replaces only the token it matched and
 * never disturbs the text around it.
 */

import type { ComposerState } from './composer.ts'
import type { TuiCommandDescriptor } from './contracts.ts'

export interface CompletionToken {
  /** Code-point bounds of the token, including its `/` or `@` sigil. */
  readonly start: number
  readonly end: number
  /** The text after the sigil, lowercased for matching. */
  readonly needle: string
}

export type CompletionKind = 'command' | 'file' | 'directory'

export interface CompletionItem {
  /** Text that replaces the token, sigil included. */
  readonly value: string
  readonly label: string
  readonly description?: string
  readonly kind: CompletionKind
  /** Whether a space should follow, so a directory can be typed into. */
  readonly terminal: boolean
}

/** A slash command occupies the whole first token of the draft. */
export function slashTokenAt(draft: string, cursor: number): CompletionToken | undefined {
  const characters = Array.from(draft)
  if (characters[0] !== '/') return undefined
  let end = 1
  while (end < characters.length && !/\s/.test(characters[end] ?? '')) end++
  if (cursor < 1 || cursor > end) return undefined
  return { start: 0, end, needle: characters.slice(1, end).join('').toLowerCase() }
}

/**
 * A mention is an `@` that starts the draft or follows whitespace, running to
 * the caret. Quoted mentions (`@"a b/c"`) keep their spaces.
 */
export function mentionTokenAt(draft: string, cursor: number): CompletionToken | undefined {
  const characters = Array.from(draft)
  const at = Math.max(0, Math.min(characters.length, cursor))
  let start = at
  while (start > 0 && characters[start - 1] !== '@') {
    if (/\s/.test(characters[start - 1] ?? '')) return undefined
    start--
  }
  if (start === 0 || characters[start - 1] !== '@') return undefined
  const sigil = start - 1
  const preceding = characters[sigil - 1]
  if (preceding !== undefined && !/\s/.test(preceding)) return undefined
  return { start: sigil, end: at, needle: characters.slice(start, at).join('').toLowerCase() }
}

/** Prefix hits first, then substring hits; ties keep the catalog order. */
function rank<T>(items: readonly T[], needle: string, key: (item: T) => string): readonly T[] {
  if (needle === '') return items
  const prefix: T[] = []
  const substring: T[] = []
  for (const item of items) {
    const candidate = key(item).toLowerCase()
    if (candidate.startsWith(needle)) prefix.push(item)
    else if (candidate.includes(needle)) substring.push(item)
  }
  return [...prefix, ...substring]
}

export function rankCommands(
  needle: string,
  commands: readonly TuiCommandDescriptor[],
): readonly CompletionItem[] {
  return rank(commands, needle, command => command.name).map(command => ({
    value: `/${command.name}`,
    label: `/${command.name}`,
    ...(command.description === '' ? {} : { description: command.description }),
    kind: 'command' as const,
    // A command that takes arguments keeps the caret on the same line.
    terminal: true,
  }))
}

export interface FileCandidate {
  /** Workspace-relative path, `/`-separated. */
  readonly path: string
  readonly directory: boolean
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Quote a mention whose path contains whitespace so it survives re-parsing. */
function mentionValue(path: string, directory: boolean): string {
  const body = directory ? `${path}/` : path
  return /\s/.test(body) ? `@"${body}"` : `@${body}`
}

/**
 * Match on the relative path *or* the basename, so `@ink` finds
 * `src/ink/Box.ts` the same way `@src/ink` does.
 */
export function rankFiles(
  needle: string,
  candidates: readonly FileCandidate[],
): readonly CompletionItem[] {
  const scored = needle === ''
    ? candidates
    : [
      ...candidates.filter(candidate => candidate.path.toLowerCase().startsWith(needle)),
      ...candidates.filter(candidate => !candidate.path.toLowerCase().startsWith(needle)
        && basename(candidate.path).toLowerCase().startsWith(needle)),
      ...candidates.filter(candidate => !candidate.path.toLowerCase().startsWith(needle)
        && !basename(candidate.path).toLowerCase().startsWith(needle)
        && candidate.path.toLowerCase().includes(needle)),
    ]
  return scored.map(candidate => ({
    value: mentionValue(candidate.path, candidate.directory),
    label: candidate.directory ? `${candidate.path}/` : candidate.path,
    kind: candidate.directory ? 'directory' as const : 'file' as const,
    // A directory keeps the caret inside it so completion can continue.
    terminal: !candidate.directory,
  }))
}

/** Replace exactly the matched token, leaving the rest of the draft alone. */
export function acceptCompletion(
  state: ComposerState,
  token: CompletionToken,
  item: CompletionItem,
): ComposerState {
  const characters = Array.from(state.draft)
  const replacement = Array.from(item.terminal ? `${item.value} ` : item.value)
  const next = [...characters.slice(0, token.start), ...replacement, ...characters.slice(token.end)]
  return {
    ...state,
    draft: next.join(''),
    cursor: token.start + replacement.length,
    historyIndex: -1,
  }
}
