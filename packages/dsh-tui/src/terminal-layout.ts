export interface TerminalLayoutInput {
  rows: number
  interactive: boolean
  approval: boolean
  approvalReason: boolean
  question?: {
    detail: boolean
    optionCount: number
    customVisible: boolean
  }
  commandCount: number
  /** Open list modal (command palette or session picker) and its entry count. */
  listModal?: { count: number }
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
  showApprovalReason: boolean
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
  }
}

export function terminalLayout(input: TerminalLayoutInput): TerminalLayout {
  const rows = Math.max(1, Math.floor(input.rows))
  const policy = terminalLayoutPolicy(rows)
  const composerRows = Math.max(1, Math.min(policy.composerRowLimit, input.composerRows ?? 1))
  let showHeader = true
  let showStatus = true
  let showContextBar = input.contextBar === true && !policy.compact
  let showWorking = input.working === true
  let todoRows = Math.max(0, Math.min(policy.todoRowLimit, input.todoRows ?? 0))
  let showNotice = input.notice && !(policy.compact && input.error)
  const showApprovalReason = input.approvalReason && !policy.compact
  const showQuestionDetail = input.question?.detail === true && !policy.compact

  const fixedRows = (): number => {
    // The transcript's top margin is fixed; its content gets all remaining rows.
    let total = 1 + Number(showHeader) + Number(showStatus) + todoRows
      + Number(showStatus && showContextBar) + Number(showWorking)
    if (input.approval) {
      total += 2 + Number(showApprovalReason)
    } else if (input.question !== undefined) {
      total += 3 + Number(showQuestionDetail)
        + Math.min(input.question.optionCount, policy.optionWindowSize)
        + Number(input.question.customVisible)
    } else if (input.listModal !== undefined) {
      total += 2 + Math.min(input.listModal.count, policy.paletteLimit)
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
    showApprovalReason,
    showQuestionDetail,
  }
}
