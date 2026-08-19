/**
 * Transcript rows.
 *
 * One row is painted the same way wherever it ends up: the scrollback and the
 * live frame differ in who owns the row afterwards, not in how it looks. That
 * is why both regions go through {@link TranscriptRow} rather than each
 * formatting its own.
 */

import React from 'react'
import { Text } from 'ink'
import { formatElapsed, spinnerFrame } from '../spinner.ts'
import { truncateToWidth } from '../terminal-text.ts'
import type { Theme } from '../theme.ts'
import type { TranscriptLine } from '../transcript-view.ts'
import { themed } from '../ui/theme-props.ts'

/**
 * A running card's header, with the static status glyph replaced by the current
 * spinner frame and the elapsed time appended. Any other row is returned as-is.
 */
export function runningText(line: TranscriptLine, now: number, animate: boolean): string {
  if (line.running === undefined) return line.text
  const { indent, rest, startedAtMs } = line.running
  const glyph = animate ? spinnerFrame(now) : line.text.slice(indent.length, indent.length + 1)
  const elapsed = startedAtMs === undefined ? '' : `  ${formatElapsed(now - startedAtMs)}`
  return `${indent}${glyph} ${rest}${elapsed}`
}

export function TranscriptRow({ line, columns, theme, now, animate }: {
  line: TranscriptLine
  columns: number
  theme: Theme
  now: number
  animate: boolean
}): React.ReactElement {
  const plain = truncateToWidth(runningText(line, now, animate), columns)
  // Styled runs are only used when the row survived truncation intact;
  // re-slicing segments to a cut width would risk splitting a wide cell.
  const segments = line.segments !== undefined && plain === line.text ? line.segments : undefined
  return <Text
    {...themed(theme, line.tone)}
    {...(theme.dim(line.tone) || !line.header) && segments === undefined ? { dimColor: true } : {}}
    {...line.header && line.tone === 'user' ? { bold: true } : {}}
  >{segments === undefined
    ? plain
    : segments.map((segment, at) => <Text
      key={String(at)}
      {...themed(theme, segment.tone ?? line.tone)}
      {...theme.enabled && segment.color !== undefined ? { color: segment.color } : {}}
      {...theme.enabled && segment.background !== undefined
        ? { backgroundColor: segment.background } : {}}
      {...segment.bold === true ? { bold: true } : {}}
      {...segment.dim === true ? { dimColor: true } : {}}
      {...segment.italic === true ? { italic: true } : {}}
      {...segment.strikethrough === true ? { strikethrough: true } : {}}
    >{segment.text}</Text>)}</Text>
}
