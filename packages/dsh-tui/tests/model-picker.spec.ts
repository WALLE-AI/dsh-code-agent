import { describe, expect, it } from 'vitest'
import {
  acceptModelPicker, backspaceModelPicker, emptyModelPicker, modelPickerRows,
  moveModelPicker, typeModelPicker,
} from '../src/model-picker.ts'
import type { TuiModelDirectory } from '../src/model-selection.ts'

const directory: TuiModelDirectory = {
  current: { provider: 'deepseek', model: 'chat' },
  providers: [{
    id: 'deepseek',
    name: 'DeepSeek',
    models: [
      { id: 'chat', name: 'DeepSeek Chat' },
      {
        id: 'reasoner',
        name: 'DeepSeek Reasoner',
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'high',
        },
      },
    ],
  }],
  failures: [],
}

describe('model picker', () => {
  it('filters models and keeps focus stable while moving', () => {
    const filtered = typeModelPicker(emptyModelPicker, 'reason')
    expect(modelPickerRows(directory, filtered).map(row => row.label)).toEqual(['DeepSeek Reasoner'])
    expect(backspaceModelPicker(filtered).query).toBe('reaso')
    const moved = moveModelPicker(emptyModelPicker, modelPickerRows(directory, emptyModelPicker), 1)
    expect(moved.focusId).toBe('deepseek/reasoner')
  })

  it('selects a normal model directly', () => {
    expect(acceptModelPicker(directory, emptyModelPicker)).toEqual({
      state: { ...emptyModelPicker, resuming: true },
      selection: { provider: 'deepseek', model: 'chat' },
    })
  })

  it('asks for reasoning effort before accepting a reasoning model', () => {
    const rows = modelPickerRows(directory, emptyModelPicker)
    const focused = moveModelPicker(emptyModelPicker, rows, 1)
    const model = acceptModelPicker(directory, focused)
    expect(model.selection).toBeUndefined()
    expect(model.state.effortFor).toEqual({ provider: 'deepseek', model: 'reasoner' })
    expect(modelPickerRows(directory, model.state).map(row => row.label)).toEqual(['Low', 'High'])
    expect(acceptModelPicker(directory, model.state).selection).toEqual({
      provider: 'deepseek', model: 'reasoner', reasoningEffort: 'low',
    })
  })
})
