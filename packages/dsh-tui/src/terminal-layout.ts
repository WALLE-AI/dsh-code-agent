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
  notice: boolean
  error: boolean
}

export interface TerminalLayoutPolicy {
  compact: boolean
  commandLimit: number
  optionWindowSize: number
}

export interface TerminalLayout extends TerminalLayoutPolicy {
  viewportRows: number
  showHeader: boolean
  showStatus: boolean
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
  }
}

export function terminalLayout(input: TerminalLayoutInput): TerminalLayout {
  const rows = Math.max(1, Math.floor(input.rows))
  const policy = terminalLayoutPolicy(rows)
  let showHeader = true
  let showStatus = true
  let showNotice = input.notice && !(policy.compact && input.error)
  const showApprovalReason = input.approvalReason && !policy.compact
  const showQuestionDetail = input.question?.detail === true && !policy.compact

  const fixedRows = (): number => {
    // The transcript's top margin is fixed; its content gets all remaining rows.
    let total = 1 + Number(showHeader) + Number(showStatus)
    if (input.approval) {
      total += 2 + Number(showApprovalReason)
    } else if (input.question !== undefined) {
      total += 3 + Number(showQuestionDetail)
        + Math.min(input.question.optionCount, policy.optionWindowSize)
        + Number(input.question.customVisible)
    } else if (input.interactive) {
      total += 2 + Math.min(input.commandCount, policy.commandLimit)
    }
    total += Number(showNotice) + Number(input.error)
    return total
  }

  // Keep the active interaction and at least one transcript row visible.
  if (fixedRows() >= rows) showStatus = false
  if (fixedRows() >= rows) showHeader = false
  if (fixedRows() >= rows) showNotice = false

  return {
    ...policy,
    viewportRows: Math.max(1, rows - fixedRows()),
    showHeader,
    showStatus,
    showNotice,
    showApprovalReason,
    showQuestionDetail,
  }
}
