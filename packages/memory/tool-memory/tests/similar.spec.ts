import { describe, expect, it } from 'vitest'
import { similarIds } from '../src/index.ts'

describe('similarIds', () => {
  it('matches ids under the same parent path, excluding the id itself', () => {
    const ids = ['bugfix/a', 'bugfix/b', 'feature/c', 'bugfix/a/deep']
    expect(similarIds(ids, 'bugfix/a')).toEqual(['bugfix/b'])
    expect(similarIds(ids, 'bugfix/a/deep')).toEqual([])
    expect(similarIds(ids, 'feature/c')).toEqual([])
  })

  it('matches root-level ids against other root-level ids only', () => {
    const ids = ['alpha', 'beta', 'bugfix/alpha', 'bugfix/beta']
    expect(similarIds(ids, 'alpha')).toEqual(['beta'])
    expect(similarIds(ids, 'bugfix/alpha')).toEqual(['bugfix/beta'])
  })

  it('returns sorted results and nothing when alone in the directory', () => {
    const ids = ['z/one', 'a/two', 'm/three', 'a/first', 'a/0']
    expect(similarIds(ids, 'a/two')).toEqual(['a/0', 'a/first'])
    expect(similarIds(ids, 'z/one')).toEqual([])
  })
})
