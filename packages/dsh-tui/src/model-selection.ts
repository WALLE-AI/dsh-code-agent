export interface TuiModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface TuiModelOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: {
    readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[]
    readonly defaultEffort?: string
  }
}

export interface TuiModelDirectory {
  readonly current: TuiModelSelection
  readonly providers: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly TuiModelOption[]
  }[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}

export type ParsedModelCommand =
  | { readonly kind: 'picker' }
  | { readonly kind: 'info' }
  | { readonly kind: 'default' }
  | { readonly kind: 'select'; readonly selection: TuiModelSelection }
  | { readonly kind: 'save'; readonly selection: TuiModelSelection }

export function formatModelSelection(selection: TuiModelSelection): string {
  const route = `${selection.provider}/${selection.model}`
  return selection.reasoningEffort === undefined ? route : `${route}:${selection.reasoningEffort}`
}

export function parseModelRoute(route: string, currentProvider: string): TuiModelSelection {
  const trimmed = route.trim()
  if (trimmed === '') throw new Error('model route must not be empty')
  const [target, effort, ...extraEfforts] = trimmed.split(':')
  if (extraEfforts.length > 0) throw new Error(`model route ${route} has more than one effort suffix`)
  if (effort !== undefined && effort.trim() === '') throw new Error(`model route ${route} has an empty effort`)
  const parts = (target ?? '').split('/')
  if (parts.length > 2) throw new Error(`model route ${route} has more than one provider separator`)
  if (parts.some(part => part.trim() === '')) throw new Error(`model route ${route} has an empty component`)
  const provider = parts.length === 1 ? currentProvider : parts[0] as string
  const model = parts.length === 1 ? parts[0] as string : parts[1] as string
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort.trim() }),
  }
}

export function parseModelCommand(
  input: string,
  current: TuiModelSelection,
): ParsedModelCommand {
  const trimmed = input.trim()
  if (trimmed === '') return { kind: 'picker' }
  if (trimmed === 'info') return { kind: 'info' }
  if (trimmed === 'default') return { kind: 'default' }
  if (trimmed === 'save') throw new Error('/model save requires a model route')
  if (trimmed.startsWith('save ')) {
    return { kind: 'save', selection: parseModelRoute(trimmed.slice(5), current.provider) }
  }
  return { kind: 'select', selection: parseModelRoute(trimmed, current.provider) }
}

interface ModelEvent {
  readonly type: string
  readonly data: Record<string, any>
}

/** Fold successful persisted model commands in command-id order. */
export function modelSelectionFromEvents(
  events: readonly ModelEvent[],
  initial: TuiModelSelection,
): TuiModelSelection {
  const runs = new Map<string, string>()
  let selected = initial
  for (const event of events) {
    const id = typeof event.data.commandId === 'string' ? event.data.commandId : undefined
    if (id === undefined) continue
    if (event.type === 'command/run' && event.data.name === 'model') {
      runs.set(id, typeof event.data.args === 'string' ? event.data.args : '')
      continue
    }
    if (event.type !== 'command/done' || event.data.kind !== 'success') continue
    const input = runs.get(id)
    if (input === undefined) continue
    try {
      const parsed = parseModelCommand(input, selected)
      if (parsed.kind === 'select' || parsed.kind === 'save') selected = parsed.selection
      if (parsed.kind === 'default') {
        const route = typeof event.data.text === 'string'
          ? /^Model set to (\S+)/.exec(event.data.text)?.[1]
          : undefined
        selected = route === undefined ? initial : parseModelRoute(route, initial.provider)
      }
    } catch {
      // A malformed historical command cannot make the session unresumable.
    }
  }
  return selected
}
