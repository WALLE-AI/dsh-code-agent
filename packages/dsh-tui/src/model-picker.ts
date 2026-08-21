import { formatModelSelection, type TuiModelDirectory, type TuiModelSelection } from './model-selection.ts'

export interface ModelPickerRow {
  readonly id: string
  readonly label: string
  readonly detail: string
  readonly selection: TuiModelSelection
  readonly active: boolean
}

export interface ModelPickerState {
  readonly query: string
  readonly focusId?: string
  readonly effortFor?: TuiModelSelection
  readonly resuming: boolean
}

export const emptyModelPicker: ModelPickerState = Object.freeze({ query: '', resuming: false })

export function modelPickerRows(
  directory: TuiModelDirectory | undefined,
  state: ModelPickerState,
): readonly ModelPickerRow[] {
  if (directory === undefined) return []
  if (state.effortFor !== undefined) {
    const model = directory.providers.flatMap(provider => provider.models.map(option => ({ provider, option })))
      .find(item => item.provider.id === state.effortFor?.provider && item.option.id === state.effortFor.model)
    return (model?.option.reasoning?.efforts ?? []).map(effort => {
      const selection = { ...state.effortFor!, reasoningEffort: effort.id }
      return {
        id: formatModelSelection(selection),
        label: effort.name,
        detail: effort.description ?? `Reasoning effort ${effort.id}`,
        selection,
        active: directory.current.reasoningEffort === effort.id
          && directory.current.provider === selection.provider
          && directory.current.model === selection.model,
      }
    })
  }
  const needle = state.query.trim().toLowerCase()
  return directory.providers.flatMap(provider => provider.models.flatMap(model => {
    const selection: TuiModelSelection = { provider: provider.id, model: model.id }
    const text = `${provider.name} ${provider.id} ${model.name} ${model.id} ${model.description ?? ''}`.toLowerCase()
    if (needle !== '' && !text.includes(needle)) return []
    return [{
      id: formatModelSelection(selection),
      label: model.name,
      detail: `${provider.name}${model.description === undefined ? '' : ` · ${model.description}`}`,
      selection,
      active: directory.current.provider === provider.id && directory.current.model === model.id,
    }]
  }))
}

export function modelPickerFocus(rows: readonly ModelPickerRow[], state: ModelPickerState): number {
  if (rows.length === 0) return 0
  const found = rows.findIndex(row => row.id === state.focusId)
  return found < 0 ? 0 : found
}

export function moveModelPicker(
  state: ModelPickerState,
  rows: readonly ModelPickerRow[],
  delta: number,
): ModelPickerState {
  if (rows.length === 0) return state
  const index = Math.max(0, Math.min(rows.length - 1, modelPickerFocus(rows, state) + delta))
  const id = rows[index]?.id
  return id === undefined ? state : { ...state, focusId: id }
}

export function typeModelPicker(state: ModelPickerState, text: string): ModelPickerState {
  if (state.effortFor !== undefined) return state
  const clean = text.replace(/\p{Cc}/gu, '')
  if (clean === '') return state
  const { focusId: _focusId, ...withoutFocus } = state
  return { ...withoutFocus, query: state.query + clean }
}

export function backspaceModelPicker(state: ModelPickerState): ModelPickerState {
  if (state.effortFor !== undefined) return state
  const { focusId: _focusId, ...withoutFocus } = state
  return { ...withoutFocus, query: Array.from(state.query).slice(0, -1).join('') }
}

export function acceptModelPicker(
  directory: TuiModelDirectory | undefined,
  state: ModelPickerState,
): { readonly state: ModelPickerState; readonly selection?: TuiModelSelection } {
  const rows = modelPickerRows(directory, state)
  const chosen = rows[modelPickerFocus(rows, state)]
  if (chosen === undefined) return { state }
  if (state.effortFor !== undefined) return { state: { ...state, resuming: true }, selection: chosen.selection }
  const model = directory?.providers.find(provider => provider.id === chosen.selection.provider)
    ?.models.find(option => option.id === chosen.selection.model)
  if ((model?.reasoning?.efforts.length ?? 0) > 0) {
    return { state: { query: '', effortFor: chosen.selection, resuming: false } }
  }
  return { state: { ...state, resuming: true }, selection: chosen.selection }
}
