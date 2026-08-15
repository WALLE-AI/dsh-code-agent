import { describe, expect, it } from 'vitest'
import {
  emptyViewport, scrollViewport, syncViewport, viewportLines,
} from '../src/viewport.ts'

describe('transcript viewport', () => {
  it('follows the bottom until the user scrolls and clears unread on return', () => {
    let state = syncViewport(emptyViewport, 20, 1, 5)
    expect(viewportLines([...Array(20).keys()], state, 5)).toEqual([15, 16, 17, 18, 19])
    state = scrollViewport(state, -1, 5, 5)
    expect(viewportLines([...Array(20).keys()], state, 5)).toEqual([10, 11, 12, 13, 14])
    state = syncViewport(state, 22, 2, 5)
    expect(state).toMatchObject({ offsetFromBottom: 7, unread: 2 })
    expect(viewportLines([...Array(22).keys()], state, 5)).toEqual([10, 11, 12, 13, 14])
    state = scrollViewport(state, 1, 100, 5)
    expect(state).toMatchObject({ offsetFromBottom: 0, unread: 0 })
  })

  it('counts a streaming revision while paused even without a new line', () => {
    let state = syncViewport(emptyViewport, 10, 1, 4)
    state = scrollViewport(state, -1, 2, 4)
    state = syncViewport(state, 10, 2, 4)
    expect(state).toMatchObject({ offsetFromBottom: 2, unread: 1 })
  })

  it('clamps offsets when capacity grows or history is rebuilt shorter', () => {
    let state = syncViewport(emptyViewport, 12, 1, 4)
    state = scrollViewport(state, -1, 8, 4)
    state = syncViewport(state, 5, 2, 10)
    expect(state.offsetFromBottom).toBe(0)
    expect(viewportLines(['a', 'b', 'c', 'd', 'e'], state, 10)).toHaveLength(5)
  })
})
