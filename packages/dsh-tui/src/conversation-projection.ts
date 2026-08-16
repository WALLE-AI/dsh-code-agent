import type {
  ConversationSnapshot,
  ProjectionIssue,
  TerminalEvent,
  TextNode,
  ToolNode,
  TranscriptNode,
} from './contracts.ts'

/**
 * Cheap structural fingerprint used for duplicate detection. A number keeps the
 * per-event memory constant on very long logs, unlike a retained JSON copy.
 */
function eventFingerprint(event: TerminalEvent): number {
  let hash = 0x811c9dc5
  const mix = (value: string): void => {
    for (let index = 0; index < value.length; index++) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0x5f
  }
  mix(event.kind)
  mix(event.text)
  mix(event.callId ?? '')
  mix(event.messageId ?? '')
  mix(event.name ?? '')
  mix(event.parentCallId ?? '')
  mix(event.failed === true ? '1' : '0')
  if (event.metadata !== undefined) mix(JSON.stringify(event.metadata))
  return hash >>> 0
}

function textId(event: TerminalEvent, kind: TextNode['kind']): string {
  if (event.messageId !== undefined) return `${kind}:${event.messageId}`
  return `${kind}:${event.seq}`
}

function freezeSnapshot(
  nodes: readonly TranscriptNode[],
  lastSeq: number | undefined,
  issue?: ProjectionIssue,
): ConversationSnapshot {
  const value: ConversationSnapshot = {
    status: issue === undefined ? 'healthy' : 'paused',
    nodes: Object.freeze(nodes.map(node => Object.freeze({ ...node }))),
    ...(lastSeq === undefined ? {} : { lastSeq }),
    ...(issue === undefined ? {} : { issue: Object.freeze(issue) }),
  }
  return Object.freeze(value)
}

/** Deterministic, upstream-neutral fold shared by live delivery and session replay. */
export class ConversationProjection {
  private nodes: TranscriptNode[] = []
  private readonly fingerprints = new Map<number, number>()
  /** node id -> index in `nodes`, so merging never scans the transcript. */
  private readonly nodeIndex = new Map<string, number>()
  /** Call ids still awaiting a result, so an interrupt never scans either. */
  private readonly pendingTools = new Set<string>()
  private lastSeq: number | undefined
  private issue: ProjectionIssue | undefined
  private value: ConversationSnapshot = freezeSnapshot([], undefined)

  constructor(private readonly maxNodes = Number.POSITIVE_INFINITY) {
    if (maxNodes <= 0) throw new Error('maxNodes must be greater than zero')
  }

  snapshot = (): ConversationSnapshot => this.value

  append(event: TerminalEvent): boolean {
    return this.consume(event, true)
  }

  private consume(event: TerminalEvent, publish: boolean): boolean {
    if (this.issue !== undefined) return false
    const known = this.fingerprints.get(event.seq)
    const fingerprint = eventFingerprint(event)
    if (known !== undefined) {
      if (known === fingerprint) return false
      return this.pause({
        kind: 'duplicate-conflict',
        seq: event.seq,
        message: `event ${event.seq} was delivered with conflicting content`,
      })
    }
    if (this.lastSeq !== undefined && event.seq !== this.lastSeq + 1) {
      return this.pause({
        kind: 'gap',
        seq: event.seq,
        message: `expected event ${this.lastSeq + 1}, received ${event.seq}`,
      })
    }
    if (event.kind === 'unknown-required') {
      return this.pause({
        kind: 'unknown-required',
        seq: event.seq,
        message: event.text || `event ${event.seq} has unknown required semantics`,
      })
    }

    this.fingerprints.set(event.seq, fingerprint)
    this.apply(event)
    if (this.nodes.length > this.maxNodes) {
      this.nodes = this.nodes.slice(-this.maxNodes)
      this.reindex()
    }
    this.lastSeq = event.seq
    if (publish) this.value = freezeSnapshot(this.nodes, this.lastSeq)
    return true
  }

  rebuild(events: readonly TerminalEvent[]): ConversationSnapshot {
    this.nodes = []
    this.fingerprints.clear()
    this.nodeIndex.clear()
    this.pendingTools.clear()
    this.lastSeq = undefined
    this.issue = undefined
    this.value = freezeSnapshot([], undefined)
    for (const event of events) {
      this.consume(event, false)
      if (this.issue !== undefined) break
    }
    if (this.issue === undefined) this.value = freezeSnapshot(this.nodes, this.lastSeq)
    return this.value
  }

  private apply(event: TerminalEvent): void {
    switch (event.kind) {
      case 'ignored': return
      case 'user':
        this.pushNode({
          id: textId(event, 'user'), kind: 'user', text: event.text,
          firstSeq: event.seq, lastSeq: event.seq,
        })
        return
      case 'assistant-delta':
      case 'assistant-final':
      case 'reasoning-delta':
        this.mergeText(event)
        return
      case 'tool-call':
        this.mergeToolCall(event)
        return
      case 'tool-result':
        this.mergeToolResult(event)
        return
      case 'marker':
        this.pushNode({
          id: textId(event, 'marker'), kind: 'marker', text: event.text,
          firstSeq: event.seq, lastSeq: event.seq,
        })
        return
      case 'turn-end':
        this.interruptPendingTools(event.seq)
        this.pushNode({
          id: textId(event, 'turn'), kind: 'turn', text: event.text,
          firstSeq: event.seq, lastSeq: event.seq,
        })
        return
      case 'unknown-required': return
    }
  }

  private mergeText(event: TerminalEvent): void {
    const kind: TextNode['kind'] = event.kind === 'reasoning-delta' ? 'reasoning' : 'assistant'
    let id = event.messageId === undefined
      ? this.findOpenTextId(kind)
      : textId(event, kind)
    let index = this.indexOf(id)
    if (index === -1 && event.kind === 'assistant-final') {
      id = this.findOpenTextId(kind)
      index = this.indexOf(id)
    }
    if (index === -1) {
      this.pushNode({
        id: textId(event, kind), kind, text: event.text,
        firstSeq: event.seq, lastSeq: event.seq,
      })
      return
    }
    const current = this.nodes[index] as TextNode
    const nextId = event.kind === 'assistant-final' && event.messageId !== undefined
      ? textId(event, kind)
      : current.id
    this.nodes[index] = {
      ...current,
      id: nextId,
      text: event.kind === 'assistant-final' ? event.text : current.text + event.text,
      lastSeq: event.seq,
    }
    if (nextId !== current.id) {
      this.nodeIndex.delete(current.id)
      this.nodeIndex.set(nextId, index)
    }
  }

  /** Append one node and keep the id index in step. */
  private pushNode(node: TranscriptNode): void {
    this.nodeIndex.set(node.id, this.nodes.length)
    this.nodes.push(node)
  }

  private indexOf(id: string | undefined): number {
    if (id === undefined) return -1
    const index = this.nodeIndex.get(id)
    return index !== undefined && this.nodes[index]?.id === id ? index : -1
  }

  private findOpenTextId(kind: TextNode['kind']): string | undefined {
    for (let index = this.nodes.length - 1; index >= 0; index--) {
      const node = this.nodes[index]
      if (node?.kind === 'turn' || node?.kind === 'user' || node?.kind === 'marker') return undefined
      if (node?.kind === kind) return node.id
    }
    return undefined
  }

  /** Rebuild the id index after the bounded tail dropped leading nodes. */
  private reindex(): void {
    this.nodeIndex.clear()
    this.pendingTools.clear()
    this.nodes.forEach((node, index) => {
      this.nodeIndex.set(node.id, index)
      if (node.kind === 'tool' && node.status === 'pending') this.pendingTools.add(node.callId)
    })
  }

  private mergeToolCall(event: TerminalEvent): void {
    const callId = event.callId ?? `seq-${event.seq}`
    const index = this.findTool(callId)
    const call: ToolNode = {
      id: `tool:${callId}`,
      kind: 'tool',
      callId,
      name: event.name ?? 'unknown',
      input: event.text,
      output: index === -1 ? '' : (this.nodes[index] as ToolNode).output,
      status: index === -1 ? 'pending' : (this.nodes[index] as ToolNode).status,
      firstSeq: index === -1 ? event.seq : (this.nodes[index] as ToolNode).firstSeq,
      lastSeq: event.seq,
      ...(event.parentCallId === undefined ? {} : { parentCallId: event.parentCallId }),
      ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
    }
    if (index === -1) this.pushNode(call)
    else this.nodes[index] = call
    if (call.status === 'pending') this.pendingTools.add(callId)
    else this.pendingTools.delete(callId)
  }

  private mergeToolResult(event: TerminalEvent): void {
    const callId = event.callId ?? `seq-${event.seq}`
    const index = this.findTool(callId)
    this.pendingTools.delete(callId)
    if (index === -1) {
      this.pushNode({
        id: `tool:${callId}`, kind: 'tool', callId, name: event.name ?? 'unknown',
        input: '', output: event.text, status: event.failed === true ? 'failed' : 'succeeded',
        firstSeq: event.seq, lastSeq: event.seq,
        ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
      })
      return
    }
    const current = this.nodes[index] as ToolNode
    this.nodes[index] = {
      ...current,
      output: event.text,
      status: event.failed === true ? 'failed' : 'succeeded',
      lastSeq: event.seq,
      ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
    }
  }

  private findTool(callId: string): number {
    return this.indexOf(`tool:${callId}`)
  }

  private interruptPendingTools(seq: number): void {
    for (const callId of this.pendingTools) {
      const index = this.findTool(callId)
      const node = index === -1 ? undefined : this.nodes[index]
      if (node?.kind !== 'tool') continue
      this.nodes[index] = { ...node, status: 'interrupted', lastSeq: seq }
    }
    this.pendingTools.clear()
  }

  private pause(issue: ProjectionIssue): true {
    this.issue = issue
    this.value = freezeSnapshot(this.nodes, this.lastSeq, issue)
    return true
  }
}
