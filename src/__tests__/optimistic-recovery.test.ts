import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { recoverOptimisticCache } from '../client/hooks/useCollection'

describe('optimistic mutation recovery', () => {
  it('invalidates authoritative data without restoring a stale snapshot', async () => {
    const client = new QueryClient()
    const queryKey = ['todos', 'tenant', undefined] as const
    const concurrentSuccess = [{ id: '1', title: 'newer successful value' }]
    client.setQueryData(queryKey, concurrentSuccess)

    await recoverOptimisticCache(client, queryKey)

    expect(client.getQueryData(queryKey)).toEqual(concurrentSuccess)
    expect(client.getQueryState(queryKey)?.isInvalidated).toBe(true)
  })
})
