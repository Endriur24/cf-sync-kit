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
})
