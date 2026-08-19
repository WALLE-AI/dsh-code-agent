/**
 * One row per answer, when the caller does not say how many. Two is the floor:
 * `allow once` and `reject` are always offered, whatever else `approval-options`
 * adds on a terminal with room for it.
 */
const DEFAULT_APPROVAL_CHOICE_ROWS = 2

export interface TerminalLayoutInput {
  rows: number
  interactive: boolean
  approval: boolean
  /**
   * Rows the approval preview would like: the call's header, the first lines of
   * its body and the escalation reason. Clamped to the policy limit and then to
   * whatever the budget leaves.
   */
  approvalPreviewRows?: number
  /** One row per answer the panel is showing; the answers are never dropped. */
  approvalChoiceRows?: number
  /** The rejection-reason field is open, and owns a row of its own. */
  approvalFeedback?: boolean
  question?: {
    detail: boolean
    optionCount: number
    customVisible: boolean
  }
  commandCount: number
  /**
   * An open overlay region and the rows its entries would like. Every list that
   * takes over the composer's space — palette, picker — is the same region, so
   * the budget knows it by shape rather than by which one is showing.
   */
  overlay?: { rows: number }
  notice: boolean
  error: boolean
  /** Rows the multi-line composer needs; clamped to the policy maximum. */
  composerRows?: number
  /** Rows the goal/todo panel would like, before the budget is applied. */
  todoRows?: number
  /** The projection reported context pressure, so a bar row is worth reserving. */
  contextBar?: boolean
  /** The Agent is working, so the status line above the composer wants a row. */
  working?: boolean
}

export interface TerminalLayoutPolicy {
  compact: boolean
  commandLimit: number
  optionWindowSize: number
  composerRowLimit: number
  /** Rows one list modal may use for its entries. */
  paletteLimit: number
  /** Rows the goal/todo panel may use. */
  todoRowLimit: number
  /** Rows the approval preview may use. */
  approvalPreviewLimit: number
}

export interface TerminalLayout extends TerminalLayoutPolicy {
  viewportRows: number
  /** Composer rows the frame actually reserved. */
  composerRows: number
  /** Goal/todo panel rows the frame actually reserved. */
  todoRows: number
  showHeader: boolean
  showStatus: boolean
  /** The context bar gets its own row above the status segments. */
  showContextBar: boolean
  /** The working line fits above the composer. */
  showWorking: boolean
  showNotice: boolean
  /** Approval preview rows the frame actually reserved. */
  approvalPreviewRows: number
  /** The blank row separating the approval from the transcript above it. */
  showApprovalMargin: boolean
  showQuestionDetail: boolean
}

export function terminalLayoutPolicy(rows: number): TerminalLayoutPolicy {
  const compact = rows < 16
  return {
    compact,
    commandLimit: compact ? 1 : 3,
    optionWindowSize: compact ? 1 : 5,
    composerRowLimit: compact ? 1 : 3,
    paletteLimit: compact ? 2 : 6,
    todoRowLimit: compact ? 0 : 2,
    approvalPreviewLimit: compact ? 1 : 5,
  }
}

export function terminalLayout(input: TerminalLayoutInput): TerminalLayout {
  const terminalRows = Math.max(1, Math.floor(input.rows))
  /**
   * One row of headroom, and it is not cosmetic. Ink repaints incrementally
   * only while the frame is shorter than the terminal; at `outputHeight >=
   * stdout.rows` it falls back to erasing the whole screen and rewriting it
   * (`ink.js:121`). A frame sized to exactly `rows` therefore clears on every
   * render, which reads as a hard flicker once anything animates.
   */
  const rows = Math.max(1, terminalRows - 1)
  const policy = terminalLayoutPolicy(terminalRows)
  const composerRows = Math.max(1, Math.min(policy.composerRowLimit, input.composerRows ?? 1))
  let showHeader = true
  let showStatus = true
  let showContextBar = input.contextBar === true && !policy.compact
  let showWorking = input.working === true
  let todoRows = Math.max(0, Math.min(policy.todoRowLimit, input.todoRows ?? 0))
  let showNotice = input.notice && !(policy.compact && input.error)
  let showApprovalMargin = true
  let approvalPreviewRows = Math.max(
    0, Math.min(policy.approvalPreviewLimit, input.approvalPreviewRows ?? 0),
  )
  const showQuestionDetail = input.question?.detail === true && !policy.compact

  const fixedRows = (): number => {
    // The transcript's top margin is fixed; its content gets all remaining rows.
    let total = 1 + Number(showHeader) + Number(showStatus) + todoRows
      + Number(showStatus && showContextBar) + Number(showWorking)
    if (input.approval) {
      // A separating blank row, the `Approve <tool>?` title, the preview, and
      // one row per answer. Title and answers are not optional: they name the
      // tool and *are* the interaction.
      total += Number(showApprovalMargin) + 1 + approvalPreviewRows
        + Math.max(1, input.approvalChoiceRows ?? DEFAULT_APPROVAL_CHOICE_ROWS)
        + Number(input.approvalFeedback === true)
    } else if (input.question !== undefined) {
      total += 3 + Number(showQuestionDetail)
        + Math.min(input.question.optionCount, policy.optionWindowSize)
        + Number(input.question.customVisible)
    } else if (input.overlay !== undefined) {
      // Two more for the pane's title row and its scroll hint.
      total += 2 + Math.min(input.overlay.rows, policy.paletteLimit)
    } else if (input.interactive) {
      total += 1 + composerRows + Math.min(input.commandCount, policy.commandLimit)
    }
    total += Number(showNotice) + Number(input.error)
    return total
  }

  // Keep the active interaction and at least one transcript row visible. The
  // order is the drop order: decoration first, then the panel, then the chrome.
  if (fixedRows() >= rows) showContextBar = false
  // The working line outranks the panel: it is the only thing saying the run is
  // still alive.
  while (todoRows > 0 && fixedRows() >= rows) todoRows--
  if (fixedRows() >= rows) showWorking = false
  if (fixedRows() >= rows) showStatus = false
  if (fixedRows() >= rows) showHeader = false
  if (fixedRows() >= rows) showNotice = false
  // Last, because the preview is the evidence the decision turns on. It goes
  // only when the alternative is pushing the answers themselves off the screen.
  while (approvalPreviewRows > 0 && fixedRows() >= rows) approvalPreviewRows--
  // On a terminal this short the blank spacer is the last row worth anything.
  if (fixedRows() >= rows) showApprovalMargin = false

  return {
    ...policy,
    composerRows,
    todoRows,
    showWorking,
    viewportRows: Math.max(1, rows - fixedRows()),
    showHeader,
    showStatus,
    showContextBar,
    showNotice,
    approvalPreviewRows,
    showApprovalMargin,
    showQuestionDetail,
  }
}
