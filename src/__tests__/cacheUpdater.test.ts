import { describe, it, expect, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { applyMutationToCache } from '../client/hooks/cacheUpdater'

describe('applyMutationToCache', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
  })

  it('updates item in-place by default (reorderOnUpdate = false)', () => {
    queryClient.setQueryData(['todos', 'default', undefined], [
      { id: '1', title: 'First', completed: false },
      { id: '2', title: 'Second', completed: false },
      { id: '3', title: 'Third', completed: false },
    ])

    applyMutationToCache(
      queryClient,
      'todos',
      'default',
      undefined,
      'update',
      { id: '2', completed: true }
    )

    const updated = queryClient.getQueryData<any[]>(['todos', 'default', undefined])
    expect(updated).toEqual([
      { id: '1', title: 'First', completed: false },
      { id: '2', title: 'Second', completed: true },
      { id: '3', title: 'Third', completed: false },
    ])
  })

  it('moves updated item to the top when reorderOnUpdate is true', () => {
    queryClient.setQueryData(['todos', 'default', undefined], [
      { id: '1', title: 'First', completed: false },
      { id: '2', title: 'Second', completed: false },
      { id: '3', title: 'Third', completed: false },
    ])

    applyMutationToCache(
      queryClient,
      'todos',
      'default',
      undefined,
      'update',
      { id: '2', completed: true },
      undefined,
      undefined,
      { reorderOnUpdate: true }
    )

    const updated = queryClient.getQueryData<any[]>(['todos', 'default', undefined])
    expect(updated).toEqual([
      { id: '2', title: 'Second', completed: true },
      { id: '1', title: 'First', completed: false },
      { id: '3', title: 'Third', completed: false },
    ])
  })

  it('updates the unscoped cache and only the matching scoped cache', () => {
    const initial = [
      { id: 'a', title: 'Scope A' },
      { id: 'b', title: 'Scope B' },
    ]
    queryClient.setQueryData(['todos', 'room', undefined], initial)
    queryClient.setQueryData(['todos', 'room', 'scope-a'], [initial[0]])
    queryClient.setQueryData(['todos', 'room', 'scope-b'], [initial[1]])
    queryClient.setQueryData(['todos', 'other-room', undefined], initial)

    applyMutationToCache(
      queryClient,
      'todos',
      'room',
      'scope-a',
      'update',
      { id: 'a', title: 'Updated A' },
    )

    expect(queryClient.getQueryData(['todos', 'room', undefined])).toEqual([
      { id: 'a', title: 'Updated A' },
      initial[1],
    ])
    expect(queryClient.getQueryData(['todos', 'room', 'scope-a'])).toEqual([
      { id: 'a', title: 'Updated A' },
    ])
    expect(queryClient.getQueryData(['todos', 'room', 'scope-b'])).toEqual([initial[1]])
    expect(queryClient.getQueryData(['todos', 'other-room', undefined])).toEqual(initial)
  })

  it('applies an unscoped mutation only to the unscoped cache', () => {
    queryClient.setQueryData(['todos', 'room', undefined], [])
    queryClient.setQueryData(['todos', 'room', 'scope-a'], [])

    applyMutationToCache(
      queryClient,
      'todos',
      'room',
      undefined,
      'insert',
      { id: 'unscoped', title: 'Unscoped' },
    )

    expect(queryClient.getQueryData(['todos', 'room', undefined])).toEqual([
      { id: 'unscoped', title: 'Unscoped' },
    ])
    expect(queryClient.getQueryData(['todos', 'room', 'scope-a'])).toEqual([])
  })
})
