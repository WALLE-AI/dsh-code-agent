import { describe, expect, it } from 'vitest'
import { terminalLayout, terminalLayoutPolicy } from '../src/terminal-layout.ts'

/**
 * Rows the frame occupies, mirroring how `terminalLayout` spends its budget.
 * The transcript's top margin is the fixed `1`.
 */
function frameRows(layout: ReturnType<typeof terminalLayout>, input: {
  interactive: boolean
  approval?: boolean
  question?: unknown
  overlay?: unknown
  commandCount?: number
  notice?: boolean
  error?: boolean
}): number {
  let total = 1 + Number(layout.showStatus) + layout.todoRows
    + Number(layout.showStatus && layout.showContextBar) + Number(layout.showWorking)
    + layout.viewportRows
  // A separating blank row, the title, the preview, and one row per answer.
  if (input.approval === true) {
    total += Number(layout.showApprovalMargin) + 1 + 2 + layout.approvalPreviewRows
  }
  else if (input.question !== undefined) {
    total += 3 + Number(layout.showQuestionDetail)
  } else if (input.overlay !== undefined) total += 2
  else if (input.interactive) {
    total += 1 + layout.composerRows + Math.min(input.commandCount ?? 0, layout.commandLimit)
  }
  total += Number(layout.showNotice) + Number(input.error === true)
  return total
}

describe('terminal layout', () => {
  it('always leaves a row of headroom below the terminal height', () => {
    // Ink erases and rewrites the whole screen whenever the frame reaches the
    // terminal height (`ink.js:121`), which reads as a flicker on every render.
    // The frame must stay strictly shorter than the terminal — except on a
    // terminal so short that the floor (one transcript row plus the composer)
    // cannot fit under it, where showing the conversation wins over the flicker.
    for (let rows = 6; rows <= 60; rows++) {
      for (const commandCount of [0, 3]) {
        for (const approval of [false, true]) {
          const input = {
            rows, interactive: true, approval, approvalPreviewRows: 5,
            commandCount, notice: false, error: false,
            todoRows: 2, contextBar: true, working: true, composerRows: 2,
          }
          const layout = terminalLayout(input)
          expect(
            frameRows(layout, input),
            `frame filled the terminal at ${String(rows)} rows, approval=${String(approval)}`,
          ).toBeLessThan(rows)
        }
      }
    }
  })

  it('keeps both answers on screen by trimming the approval preview', () => {
    // The preview is the evidence, but the answers are the interaction: an
    // approval that cannot be answered is worse than one you cannot inspect.
    const short = terminalLayout({
      rows: 10, interactive: true, approval: true, approvalPreviewRows: 5,
      commandCount: 0, notice: false, error: false, working: true,
    })
    expect(short.approvalPreviewRows).toBeLessThan(5)
    expect(short.viewportRows).toBeGreaterThanOrEqual(1)
    // Given the room, the whole preview is kept.
    expect(terminalLayout({
      rows: 40, interactive: true, approval: true, approvalPreviewRows: 5,
      commandCount: 0, notice: false, error: false, working: true,
    }).approvalPreviewRows).toBe(5)
  })


  it('allocates exact rows for a normal interactive command palette', () => {
    expect(terminalLayoutPolicy(24)).toMatchObject({
      compact: false, commandLimit: 3, optionWindowSize: 5,
    })
    expect(terminalLayout({
      rows: 24,
      interactive: true,
      approval: false,
      approvalPreviewRows: 0,
      commandCount: 3,
      notice: false,
      error: false,
    })).toMatchObject({ viewportRows: 16, showStatus: true })
  })

  it('compresses question details and option windows at 80x12 height', () => {
    expect(terminalLayout({
      rows: 12,
      interactive: true,
      approval: false,
      approvalPreviewRows: 0,
      question: { detail: true, optionCount: 8, customVisible: true },
      commandCount: 0,
      notice: false,
      error: false,
    })).toMatchObject({
      compact: true,
      viewportRows: 4,
      optionWindowSize: 1,
      showQuestionDetail: false,
      showStatus: true,
    })
  })

  it('prioritizes errors over notices in compact mode', () => {
    expect(terminalLayout({
      rows: 12,
      interactive: true,
      approval: false,
      approvalPreviewRows: 0,
      commandCount: 0,
      notice: true,
      error: true,
    })).toMatchObject({ showNotice: false, viewportRows: 6 })
  })

  it('drops framing before active question controls at extreme height', () => {
    expect(terminalLayout({
      rows: 8,
      interactive: true,
      approval: false,
      approvalPreviewRows: 0,
      question: { detail: true, optionCount: 8, customVisible: true },
      commandCount: 0,
      notice: false,
      error: false,
    })).toMatchObject({
      viewportRows: 1,
      // With the headroom reserved, the status chrome goes at this height.
      showStatus: false,
      showQuestionDetail: false,
    })
  })
})
