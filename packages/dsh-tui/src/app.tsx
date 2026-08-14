import React, { useSyncExternalStore } from 'react'
import { Box, render, Text, useInput } from 'ink'
import type { TuiActions, TuiView } from './contracts.ts'
import type { TuiStore } from './state.ts'

export function TuiApp({ store, actions }: { store: TuiStore; actions: TuiActions }): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  useInput((input, key) => {
    if (key.ctrl && input === 'c') return actions.cancel()
    if (state.approval === undefined) return
    if (input.toLowerCase() === 'y') actions.decideApproval(true)
    if (input.toLowerCase() === 'n' || key.escape || key.return) actions.decideApproval(false)
  })
  return <Box flexDirection="column">
    <Box justifyContent="space-between"><Text bold>DeepSeek Harness TUI</Text><Text>{state.status}</Text></Box>
    <Box flexDirection="column" marginTop={1}>
      {state.lines.map((line, index) => <Text key={`${String(index)}:${line}`}>{line}</Text>)}
    </Box>
    {state.approval === undefined ? null : <Box flexDirection="column" marginTop={1}>
      <Text color="yellow">Approve {state.approval.toolName}? [y/N]</Text>
      {state.approval.reason === undefined ? null : <Text dimColor>{state.approval.reason}</Text>}
    </Box>}
    {state.error === undefined ? null : <Text color="red">{state.error}</Text>}
  </Box>
}

export function createInkView(
  store: TuiStore,
  actions: TuiActions,
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): TuiView {
  const instance = render(<TuiApp store={store} actions={actions} />, { stdin, stdout, stderr })
  return { unmount: () => { instance.unmount() } }
}
