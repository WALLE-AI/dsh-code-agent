/**
 * The two hooks that own a timer or a listener.
 *
 * Both are here rather than in `app.tsx` so the idle-cost claim is checkable in
 * one place: a settled session must hold no interval at all.
 */

import { useEffect, useState } from 'react'

/**
 * Re-render on a fixed period while something is running.
 *
 * The timer exists only while `active`, so a settled session holds no interval
 * at all — an idle TUI must not wake the event loop 12 times a second.
 */
export function useAnimationClock(active: boolean, periodMs: number): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => { setTick(current => current + 1) }, periodMs)
    return () => { clearInterval(timer) }
  }, [active, periodMs])
  return tick
}

export function useTerminalSize(stdout: NodeJS.WriteStream): { rows: number; columns: number } {
  const [size, setSize] = useState({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 })
  useEffect(() => {
    const resize = (): void => {
      setSize({ rows: stdout.rows ?? 24, columns: stdout.columns ?? 80 })
    }
    stdout.on('resize', resize)
    return () => { stdout.off('resize', resize) }
  }, [stdout])
  return size
}
