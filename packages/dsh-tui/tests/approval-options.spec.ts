/**
 * The answers an approval offers.
 *
 * The invariant under every test here is that the panel never offers a decision
 * the Harness cannot honour: the outcome handed back is always one of its two
 * one-shot values, and anything wider is composed out of a command that already
 * exists.
 */

import { describe, expect, it } from 'vitest'
import {
  approvalOptions, defaultApprovalChoice, shortcutApprovalChoice,
} from '../src/approval-options.ts'

const presets = {
  current: 'workspace-write',
  options: [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
  ],
}

describe('what is offered', () => {
  it('always offers the two answers the Harness can actually settle', () => {
    const bare = approvalOptions(undefined)
    expect(bare.some(option => option.id === 'allow-once' && option.allowed)).toBe(true)
    expect(bare.some(option => option.id === 'reject' && !option.allowed)).toBe(true)
  })

  it('offers the preset switch the mode cycle would reach, and names it', () => {
    const option = approvalOptions(presets).find(item => item.thenCommand !== undefined)
    expect(option?.label).toBe('allow once, then switch to danger-full-access')
    // Composed out of the official command, so the second confirmation the
    // command handler requires for the unrestricted preset still applies.
    expect(option?.thenCommand).toBe('/permission danger-full-access')
    expect(option?.allowed).toBe(true)
  })

  it('offers no preset switch when there is nowhere to switch to', () => {
    expect(approvalOptions({ current: 'a', options: [{ value: 'a', name: 'a' }] })
      .some(option => option.thenCommand !== undefined)).toBe(false)
    // A current value the table does not contain is not a position to advance from.
    expect(approvalOptions({ current: 'unknown', options: presets.options })
      .some(option => option.thenCommand !== undefined)).toBe(false)
  })

  it('offers to send the reason with the rejection', () => {
    const option = approvalOptions(presets).find(item => item.acceptsFeedback === true)
    expect(option?.allowed).toBe(false)
    expect(option?.label).toBe('reject, and say why')
  })

  it('keeps only the two settling answers on a terminal with no room', () => {
    const compact = approvalOptions(presets, true)
    expect(compact.map(option => option.id)).toEqual(['allow-once', 'reject'])
  })

  it('keeps 1 and 2 meaning allow-once and reject, and never arms a mode change', () => {
    const options = approvalOptions(presets)
    expect(options[0]?.id).toBe('allow-once')
    expect(options[1]?.id).toBe('reject')
    // Moving up from the armed default is the oldest habit there is; it must
    // not land on the row that changes the session's permission preset.
    const above = options[defaultApprovalChoice(options) - 1]
    expect(above?.id).toBe('allow-once')
    expect(options.at(-1)?.id).toBe('allow-then-preset')
  })
})

describe('which answer is armed', () => {
  it('defaults to a rejection that settles on its own', () => {
    const options = approvalOptions(presets)
    const armed = options[defaultApprovalChoice(options)]
    expect(armed?.allowed).toBe(false)
    // An approval answered by accident must fail closed — and must not open a
    // text field to do it.
    expect(armed?.acceptsFeedback).toBeUndefined()
  })

  it('sends y and n to answers that settle, never to ones that ask for more', () => {
    const options = approvalOptions(presets)
    const yes = options[shortcutApprovalChoice(options, true)]
    expect(yes?.id).toBe('allow-once')
    // `y` must not silently change the permission preset for the session.
    expect(yes?.thenCommand).toBeUndefined()
    const no = options[shortcutApprovalChoice(options, false)]
    expect(no?.id).toBe('reject')
    expect(no?.acceptsFeedback).toBeUndefined()
  })
})
