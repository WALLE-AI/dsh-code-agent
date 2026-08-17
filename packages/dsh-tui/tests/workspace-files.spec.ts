import { describe, expect, it, vi } from 'vitest'
import { listWorkspaceFiles, type DirectoryEntry } from '../src/workspace-files.ts'

const TREE: Record<string, readonly DirectoryEntry[]> = {
  '': [
    { name: 'src', directory: true },
    { name: 'node_modules', directory: true },
    { name: '.git', directory: true },
    { name: 'README.md', directory: false },
  ],
  src: [
    { name: 'app.tsx', directory: false },
    { name: 'ink', directory: true },
  ],
  'src/ink': [{ name: 'Box.ts', directory: false }],
}

const read = (path: string): readonly DirectoryEntry[] => {
  const entries = TREE[path]
  if (entries === undefined) throw new Error(`no such directory: ${path}`)
  return entries
}

describe('workspace file listing', () => {
  it('walks from the prefix directory and skips noise', () => {
    const paths = listWorkspaceFiles('', read).map(candidate => candidate.path)
    expect(paths).toContain('README.md')
    expect(paths).toContain('src/app.tsx')
    expect(paths).toContain('src/ink/Box.ts')
    expect(paths).not.toContain('node_modules')
    expect(paths).not.toContain('.git')
  })

  it('anchors the walk on the directory the prefix already names', () => {
    const reader = vi.fn(read)
    const paths = listWorkspaceFiles('src/in', reader).map(candidate => candidate.path)
    expect(paths).toEqual(['src/app.tsx', 'src/ink', 'src/ink/Box.ts'])
    // The root is never re-walked once the prefix names a subdirectory.
    expect(reader).not.toHaveBeenCalledWith('')
  })

  it('marks directories so completion can continue into them', () => {
    expect(listWorkspaceFiles('src/in', read))
      .toContainEqual({ path: 'src/ink', directory: true })
  })

  it('refuses a prefix that climbs out of the workspace', () => {
    expect(listWorkspaceFiles('../secrets/key', read)).toEqual([])
  })

  it('degrades to the candidates it already has when a directory is unreadable', () => {
    const partial = (path: string): readonly DirectoryEntry[] => {
      if (path === 'src/ink') throw new Error('permission denied')
      return read(path)
    }
    const paths = listWorkspaceFiles('', partial).map(candidate => candidate.path)
    expect(paths).toContain('src/app.tsx')
    expect(paths).not.toContain('src/ink/Box.ts')
  })

  it('stops at the candidate limit', () => {
    const wide = (path: string): readonly DirectoryEntry[] => path !== ''
      ? []
      : Array.from({ length: 500 }, (_, index) => ({
        name: `file-${String(index)}`, directory: false,
      }))
    expect(listWorkspaceFiles('', wide, { limit: 20 })).toHaveLength(20)
  })
})
