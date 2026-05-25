import type { QueryClient } from '@tanstack/react-query'
import type { ActionType } from '../../shared/types'

/**
 * Applies a server-side mutation result to the TanStack Query cache.
 * Used both by useMutation.onSuccess (local mutation) and useLiveSync (WebSocket broadcast).
 *
 * This is the single source of truth for cache updates — keeping it in one place
 * prevents inconsistencies between optimistic updates and broadcast-applied updates.
 */
export function applyMutationToCache(
  queryClient: QueryClient,
  collection: string,
  syncId: string,
  scope: string | undefined,
  action: ActionType,
  payload: unknown,
  compareUpdatedAt?: (existing: any, incoming: any) => any
): void {
  const targetScope = scope
  const merge = compareUpdatedAt ?? ((existing: any, incoming: any) => ({ ...existing, ...incoming }))

  queryClient.setQueryData<unknown[]>(
    [collection, syncId, targetScope],
    (oldData) => {
      if (!oldData) {
        if (action === 'insert') return [payload]
        if (action === 'bulk-insert') return payload as unknown[]
        return []
      }

      switch (action) {
        case 'insert': {
          const item = payload as { id: string }
          return (oldData as any[]).some((d) => d.id === item.id)
            ? oldData
            : [item, ...oldData]
        }
        case 'update': {
          const item = payload as { id: string }
          return (oldData as any[]).map((d) =>
            d.id === item.id ? merge(d, item) : d
          )
        }
        case 'delete': {
          const item = payload as { id: string }
          return (oldData as any[]).filter((d) => d.id !== item.id)
        }
        case 'bulk-insert': {
          const items = payload as any[]
          const existingIds = new Set((oldData as any[]).map((d) => d.id))
          const newItems = items.filter((p) => !existingIds.has(p.id))
          return [...newItems, ...oldData]
        }
        case 'bulk-update': {
          const items = payload as any[]
          const updatesMap = new Map(items.map((p) => [p.id, p]))
          return (oldData as any[]).map((d) => {
            const update = updatesMap.get(d.id)
            return update ? merge(d, update) : d
          })
        }
        case 'bulk-delete': {
          const idsArray = Array.isArray(payload) ? payload : (payload as { ids: string[] }).ids
          const idsToDelete = new Set(idsArray)
          return (oldData as any[]).filter((d) => !idsToDelete.has(d.id))
        }
        default:
          return oldData
      }
    }
  )
}
