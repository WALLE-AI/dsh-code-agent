import { describe, expect, it } from 'vitest'
import {
  formatModelSelection, modelSelectionFromEvents, parseModelCommand, parseModelRoute,
} from '../src/model-selection.ts'

describe('model selection', () => {
  it('parses full and current-provider routes', () => {
    expect(parseModelRoute('deepseek/model:high', 'current')).toEqual({
      provider: 'deepseek', model: 'model', reasoningEffort: 'high',
    })
    expect(parseModelRoute('other', 'current')).toEqual({ provider: 'current', model: 'other' })
    expect(formatModelSelection({ provider: 'p', model: 'm', reasoningEffort: 'low' })).toBe('p/m:low')
  })

  it('parses info, default, save, picker, and direct selection', () => {
    const current = { provider: 'p', model: 'm' }
    expect(parseModelCommand('', current)).toEqual({ kind: 'picker' })
    expect(parseModelCommand('info', current)).toEqual({ kind: 'info' })
    expect(parseModelCommand('default', current)).toEqual({ kind: 'default' })
    expect(parseModelCommand('next', current)).toEqual({
      kind: 'select', selection: { provider: 'p', model: 'next' },
    })
    expect(parseModelCommand('save p/future:high', current)).toEqual({
      kind: 'save', selection: { provider: 'p', model: 'future', reasoningEffort: 'high' },
    })
  })

  it('rejects malformed routes', () => {
    expect(() => parseModelRoute('', 'p')).toThrow('must not be empty')
    expect(() => parseModelRoute('p/', 'p')).toThrow('empty component')
    expect(() => parseModelRoute('p/m:', 'p')).toThrow('empty effort')
    expect(() => parseModelCommand('save', { provider: 'p', model: 'm' })).toThrow('requires')
  })

  it('restores only successful persisted model commands', () => {
    const events = [
      { type: 'command/run', data: { commandId: '1', name: 'model', args: ' p/next:high' } },
      { type: 'command/done', data: { commandId: '1', kind: 'success' } },
      { type: 'command/run', data: { commandId: '2', name: 'model', args: ' p/broken' } },
      { type: 'command/done', data: { commandId: '2', kind: 'error' } },
    ]
    expect(modelSelectionFromEvents(events, { provider: 'p', model: 'default' })).toEqual({
      provider: 'p', model: 'next', reasoningEffort: 'high',
    })
  })

  it('restores the exact model resolved by a historical default command', () => {
    const events = [
      { type: 'command/run', data: { commandId: '1', name: 'model', args: ' default' } },
      {
        type: 'command/done',
        data: { commandId: '1', kind: 'success', text: 'Model set to old-provider/old-default:high' },
      },
    ]
    expect(modelSelectionFromEvents(events, { provider: 'new-provider', model: 'new-default' }))
      .toEqual({ provider: 'old-provider', model: 'old-default', reasoningEffort: 'high' })
  })
})
