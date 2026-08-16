import React from 'react'
import { Text } from 'ink'
import { sanitizeLine } from './terminal-text.ts'

interface Props {
  /** Region name shown in the fallback row. */
  readonly region: string
  readonly onError?: (region: string, message: string) => void
  readonly children: React.ReactNode
}

interface State { readonly message?: string }

/**
 * Contain one region's render failure. A broken card degrades to a generic
 * error row instead of taking down the frame or the Agent.
 */
export class RenderBoundary extends React.Component<Props, State> {
  override state: State = {}

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError?.(
      this.props.region,
      error instanceof Error ? error.message : String(error),
    )
  }

  override render(): React.ReactNode {
    if (this.state.message === undefined) return this.props.children
    return <Text color="red">
      {sanitizeLine(`${this.props.region} could not be rendered: ${this.state.message}`)}
    </Text>
  }
}
