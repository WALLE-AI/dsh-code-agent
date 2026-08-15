import { describe, expect, it } from 'vitest'
import { terminalLayout, terminalLayoutPolicy } from '../src/terminal-layout.ts'

describe('terminal layout', () => {
  it('allocates exact rows for a normal interactive command palette', () => {
    expect(terminalLayoutPolicy(24)).toMatchObject({
      compact: false, commandLimit: 3, optionWindowSize: 5,
    })
    expect(terminalLayout({
      rows: 24,
      interactive: true,
      approval: false,
      approvalReason: false,
      commandCount: 3,
      notice: false,
      error: false,
    })).toMatchObject({ viewportRows: 16, showHeader: true, showStatus: true })
  })

  it('compresses question details and option windows at 80x12 height', () => {
    expect(terminalLayout({
      rows: 12,
      interactive: true,
      approval: false,
      approvalReason: false,
      question: { detail: true, optionCount: 8, customVisible: true },
      commandCount: 0,
      notice: false,
      error: false,
    })).toMatchObject({
      compact: true,
      viewportRows: 4,
      optionWindowSize: 1,
      showQuestionDetail: false,
      showHeader: true,
      showStatus: true,
    })
  })

  it('prioritizes errors over notices in compact mode', () => {
    expect(terminalLayout({
      rows: 12,
      interactive: true,
      approval: false,
      approvalReason: false,
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
      approvalReason: false,
      question: { detail: true, optionCount: 8, customVisible: true },
      commandCount: 0,
      notice: false,
      error: false,
    })).toMatchObject({
      viewportRows: 1,
      showHeader: true,
      showStatus: false,
      showQuestionDetail: false,
    })
  })
})
