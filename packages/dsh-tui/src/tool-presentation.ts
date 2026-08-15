import type { ToolNode, ToolPresentation, ToolRenderIntent } from './contracts.ts'

export interface ToolPresenter {
  presentCall?(args: unknown): unknown
  presentResult?(args: unknown, result: {
    content: readonly unknown[]
    isError: boolean
    meta?: unknown
  }): unknown
}

const knownCards = new Set(['generic', 'terminal', 'diff', 'search', 'read', 'web'])

function accepted(value: unknown): ToolRenderIntent | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const card = (value as { card?: unknown }).card
  return typeof card === 'string' && knownCards.has(card)
    ? structuredClone(value as ToolRenderIntent)
    : undefined
}

function argumentsOf(input: string): unknown {
  try { return JSON.parse(input) as unknown } catch { return input }
}

/** Invoke tool-owned intents softly and always retain a replayable generic fallback. */
export function presentTool(node: ToolNode, presenter?: ToolPresenter): ToolPresentation {
  const args = argumentsOf(node.input)
  let call: ToolRenderIntent | undefined
  let result: ToolRenderIntent | undefined
  try { call = accepted(presenter?.presentCall?.(args)) } catch { /* fall through */ }
  if (node.status !== 'pending') {
    try {
      result = accepted(presenter?.presentResult?.(args, {
        content: [{ type: 'text', text: node.output }],
        isError: node.status === 'failed' || node.status === 'interrupted',
        ...(node.metadata === undefined ? {} : { meta: node.metadata }),
      }))
    } catch { /* fall through */ }
  }
  return {
    call: call ?? { card: 'generic', title: node.name, rawInput: args },
    ...(node.status === 'pending' ? {} : {
      result: result ?? { card: 'generic', content: [{ type: 'text', text: node.output }] },
    }),
  }
}
