/**
 * The answers an approval may be given.
 *
 * The old panel offered two rows, `allow once` and `reject`, and that is the
 * whole reason people turn approvals off: the only way to stop being asked the
 * same question was to stop being asked any question. So the panel grows the two
 * answers that were always available and simply had nowhere to be typed.
 *
 * What it does *not* grow is a decision the Harness cannot honour. Upstream's
 * outcome set is closed — `allowed-once | rejected | cancelled | unavailable` —
 * and there is no rule-persisting grant to reach for. Session-wide permission is
 * a different mechanism entirely: the permission *preset*. So the wider answers
 * are composed out of things that already exist and say exactly what they do:
 *
 * - **allow once, then <preset>** is a one-shot grant *plus* the same
 *   `/permission` command `shift+tab` sends. The label names the preset, because
 *   the user is changing the rules of the session, not just this call. Entering
 *   the unrestricted preset still takes its own second confirmation, which lives
 *   in the command handler and is inherited here rather than reimplemented.
 * - **reject, and say why** is a rejection *plus* the message the user was going
 *   to type next anyway. Delivering it in the same step is what makes the
 *   Agent's next attempt informed rather than a retry of the same thing.
 *
 * The fail-closed default is not a constant: it is the first rejecting row,
 * wherever the list puts it.
 */

import type { ActivitySummary } from './activity.ts'

export interface ApprovalOption {
  readonly id: string
  readonly label: string
  /** The outcome handed to the Harness. */
  readonly allowed: boolean
  /**
   * A command submitted after the decision lands, when the row promises
   * something the decision alone cannot deliver.
   */
  readonly thenCommand?: string
  /** Collect one line from the user before deciding. */
  readonly acceptsFeedback?: boolean
}

/**
 * The preset the panel offers to switch to: the next one in the table, which is
 * the same one `shift+tab` would reach. Absent when there is no table, when it
 * holds a single entry, or while the current value is not in it.
 */
function nextPreset(
  permission: ActivitySummary['permission'],
): { value: string; name: string } | undefined {
  const options = permission?.options ?? []
  if (options.length < 2 || permission === undefined) return undefined
  const at = options.findIndex(option => option.value === permission.current)
  if (at === -1) return undefined
  const next = options[(at + 1) % options.length]
  if (next === undefined || next.value === permission.current) return undefined
  return { value: next.value, name: next.name || next.value }
}

/** Build the answer list for the approval showing now. */
export function approvalOptions(
  permission: ActivitySummary['permission'],
  /** Off on a terminal too short to spend four rows on the answers. */
  compact = false,
): readonly ApprovalOption[] {
  const preset = compact ? undefined : nextPreset(permission)
  // The order is load-bearing, not cosmetic. `allow once` and `reject` stay
  // first and second, so `1` and `2` mean what they have always meant and `↑`
  // from the armed default still lands on `allow once` — a user who has typed
  // that pair a hundred times must not be moved onto a row that changes the
  // session's permission preset. The row that does is therefore last: reachable
  // deliberately, never by muscle memory.
  return [
    { id: 'allow-once', label: 'allow once', allowed: true },
    { id: 'reject', label: 'reject', allowed: false },
    ...(compact ? [] : [{
      id: 'reject-with-reason',
      label: 'reject, and say why',
      allowed: false,
      acceptsFeedback: true,
    }]),
    ...(preset === undefined ? [] : [{
      id: 'allow-then-preset',
      label: `allow once, then switch to ${preset.name}`,
      allowed: true,
      thenCommand: `/permission ${preset.value}`,
    }]),
  ]
}

/**
 * The row highlighted before the user moves: the first rejecting answer that
 * asks for nothing further. An approval that is answered by accident must fail
 * closed, and must not open a text field to do it.
 */
export function defaultApprovalChoice(options: readonly ApprovalOption[]): number {
  const at = options.findIndex(option => !option.allowed && option.acceptsFeedback !== true)
  if (at !== -1) return at
  const anyReject = options.findIndex(option => !option.allowed)
  return anyReject === -1 ? 0 : anyReject
}

/**
 * The row a bare `y` or `n` answers with: the first option of that outcome that
 * settles the prompt on its own. `n` must reject now, not open a field.
 */
export function shortcutApprovalChoice(
  options: readonly ApprovalOption[],
  allowed: boolean,
): number {
  const at = options.findIndex(option =>
    option.allowed === allowed
    && option.acceptsFeedback !== true
    && option.thenCommand === undefined)
  return at === -1 ? defaultApprovalChoice(options) : at
}
