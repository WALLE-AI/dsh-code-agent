import { describe, expect, it } from 'vitest'
import {
  acceptCompletion, mentionTokenAt, rankCommands, rankFiles, slashTokenAt,
  type FileCandidate,
} from '../src/draft-completion.ts'
import { emptyComposer, type ComposerState } from '../src/composer.ts'
import type { TuiCommandDescriptor } from '../src/contracts.ts'

function at(marked: string): ComposerState {
  const cursor = Array.from(marked.slice(0, marked.indexOf('|'))).length
  return { ...emptyComposer, draft: marked.replace('|', ''), cursor }
}

function show(state: ComposerState): string {
  const characters = Array.from(state.draft)
  return `${characters.slice(0, state.cursor).join('')}|${characters.slice(state.cursor).join('')}`
}

const COMMANDS: readonly TuiCommandDescriptor[] = [
  { name: 'compact', description: 'Compact context' },
  { name: 'permission', description: 'Switch preset', input: { hint: '<preset>' } },
  { name: 'resume', description: 'Resume a session' },
]

const FILES: readonly FileCandidate[] = [
  { path: 'src/app.tsx', directory: false },
  { path: 'src/ink', directory: true },
  { path: 'docs/ink-notes.md', directory: false },
  { path: 'my notes/todo.md', directory: false },
]

describe('slash tokens', () => {
  it('claims the first token when the caret is inside it', () => {
    expect(slashTokenAt('/perm', 5)).toEqual({ start: 0, end: 5, needle: 'perm' })
    expect(slashTokenAt('/permission read-only', 5)).toEqual({ start: 0, end: 11, needle: 'permission' })
  })

  it('releases the token once the caret moves past it', () => {
    expect(slashTokenAt('/permission read-only', 15)).toBeUndefined()
    expect(slashTokenAt('not a command', 3)).toBeUndefined()
    // The sigil itself is not yet a token to complete against.
    expect(slashTokenAt('/perm', 0)).toBeUndefined()
  })
})

describe('mention tokens', () => {
  it('triggers anywhere the sigil follows whitespace', () => {
    expect(mentionTokenAt('@src', 4)).toEqual({ start: 0, end: 4, needle: 'src' })
    expect(mentionTokenAt('look at @src/ap', 15)).toEqual({ start: 8, end: 15, needle: 'src/ap' })
  })

  it('ignores an at-sign glued to a word, such as an email', () => {
    expect(mentionTokenAt('me@example', 10)).toBeUndefined()
  })

  it('ends the token at whitespace', () => {
    expect(mentionTokenAt('@src/app.tsx and more', 21)).toBeUndefined()
  })
})

describe('ranking', () => {
  it('puts prefix hits ahead of substring hits for commands', () => {
    expect(rankCommands('res', COMMANDS).map(item => item.label)).toEqual(['/resume'])
    expect(rankCommands('m', COMMANDS).map(item => item.label))
      .toEqual(['/compact', '/permission', '/resume'])
  })

  it('matches a file by relative path or by basename', () => {
    expect(rankFiles('src/ink', FILES).map(item => item.label)).toEqual(['src/ink/'])
    // `ink` is not a path prefix of docs/ink-notes.md, but it is a basename one.
    expect(rankFiles('ink', FILES).map(item => item.label))
      .toEqual(['src/ink/', 'docs/ink-notes.md'])
  })

  it('marks a directory as non-terminal so completion can continue into it', () => {
    const [directory] = rankFiles('src/ink', FILES)
    expect(directory?.kind).toBe('directory')
    expect(directory?.terminal).toBe(false)
    expect(directory?.value).toBe('@src/ink/')
  })

  it('quotes a path that contains whitespace', () => {
    expect(rankFiles('my', FILES)[0]?.value).toBe('@"my notes/todo.md"')
  })
})

describe('accepting a completion', () => {
  it('replaces only the token and leaves the rest of the draft intact', () => {
    const state = at('look at @src/ap| and tell me')
    const token = mentionTokenAt(state.draft, state.cursor)
    expect(token).toBeDefined()
    const [item] = rankFiles(token?.needle ?? '', FILES)
    expect(show(acceptCompletion(state, token!, item!)))
      .toBe('look at @src/app.tsx | and tell me')
  })

  it('leaves the caret inside a directory instead of after a space', () => {
    const state = at('@src/in|')
    const token = mentionTokenAt(state.draft, state.cursor)
    const [item] = rankFiles(token?.needle ?? '', FILES)
    expect(show(acceptCompletion(state, token!, item!))).toBe('@src/ink/|')
  })

  it('keeps a command argument reviewable after accepting the name', () => {
    const state = at('/perm|')
    const token = slashTokenAt(state.draft, state.cursor)
    const [item] = rankCommands(token?.needle ?? '', COMMANDS)
    expect(show(acceptCompletion(state, token!, item!))).toBe('/permission |')
  })
})
