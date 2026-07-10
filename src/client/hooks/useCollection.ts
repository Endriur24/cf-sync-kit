import { useRef, useCallback, useEffect } from 'react'
import { useQueryClient, useQuery, useMutation } from '@tanstack/react-query'
import type { CollectionsMap, InferInsert, InferUpdate, InferEntity, PendingMutationInfo } from '../../shared/types'
import { SyncError, DEFAULT_SYNC_ID } from '../../shared/types'
import { applyMutationToCache } from './cacheUpdater'
import { useLiveSyncRegistrySafe } from '../context/ConnectionContext'
import { log as debugLog, isDev } from '../../shared/logger'

/**
 * Configuration options for useCollection.
 */
export interface UseCollectionOptions {
  /** Base API path prefix (default: '/api') */
  apiPrefix?: string
  /** Enable debug logging */
  debug?: boolean
  /**
   * Refetch data from server after a successful mutation.
   * Default: false — optimistic updates + broadcast sync are sufficient.
   */
  refetchOnSuccess?: boolean
  /**
   * Route GET requests through the Durable Object instead of direct D1 read.
   * Ensures strong consistency after DO hibernation.
   */
  consistentReads?: boolean
  /**
   * Custom headers to include in API requests (e.g. Authorization).
   */
  headers?: Record<string, string> | (() => Record<string, string>)
  /**
   * Enable optimistic UI updates. When false, the cache is only updated after
   * the server responds (pessimistic mode).
   * Default: true
   */
  optimisticUpdates?: boolean
}

function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status
    return status >= 500 || status === 0 || status === 429
  }
  return false
}

function retryDelay(failureCount: number): number {
  const delay = Math.min(1000 * 2 ** failureCount, 10000)
  return delay + Math.random() * 200
}

async function apiFetch<T = unknown>(path: string, apiPrefix: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)

  let res: Response
  try {
    res = await fetch(`${apiPrefix}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new SyncError('Request timed out after 10s', 'TIMEOUT_ERROR', 408, err)
    }
    throw new SyncError(
      err instanceof Error ? err.message : 'Network error',
      'NETWORK_ERROR',
      0,
      err
    )
  } finally {
    clearTimeout(timeoutId)
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null) as {
      error?: { message?: string; details?: unknown; issues?: Array<{ message: string; path: string[] }> }
      message?: string
    } | null

    // Extract message from: custom error, Zod validation issues, or fallback
    const zodMessage = body?.error?.issues?.[0]?.message
    const message = body?.error?.message ?? body?.message ?? zodMessage ?? `API error ${res.status}`

    throw new SyncError(message, 'API_ERROR', res.status, body)
  }
  return res.json() as Promise<T>
}

/**
 * Callback options for mutation operations.
 */
export interface MutationCallbacks<TData, TError = SyncError, TVariables = unknown> {
  onSuccess?: (data: TData, variables: TVariables) => void
  onError?: (error: TError, variables: TVariables) => void
  onSettled?: (data: TData | undefined, error: TError | null, variables: TVariables) => void
}

/**
 * Return type of useCollection hook.
 */
export interface UseCollectionResult<Entity, Insert, Update> {
  data: Entity[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  refetch: () => void
  queryKey: readonly [string, string, string | undefined]

  add: (payload: Insert, options?: MutationCallbacks<Entity, SyncError, Insert>) => void
  isAdding: boolean
  addError: SyncError | null

  update: (vars: { id: string; data: Update }, options?: MutationCallbacks<Entity, SyncError, { id: string; data: Update }>) => void
  isUpdating: boolean
  updateError: SyncError | null

  remove: (id: string, options?: MutationCallbacks<void, SyncError, string>) => void
  isRemoving: boolean
  removeError: SyncError | null

  addMany: (payloads: Insert[], options?: MutationCallbacks<Entity[], SyncError, Insert[]>) => void
  isAddingMany: boolean
  addManyError: SyncError | null

  updateMany: (payloads: { id: string; data: Update }[], options?: MutationCallbacks<Entity[], SyncError, { id: string; data: Update }[]>) => void
  isUpdatingMany: boolean
  updateManyError: SyncError | null

  removeMany: (ids: string[], options?: MutationCallbacks<void, SyncError, string[]>) => void
  isRemovingMany: boolean
  removeManyError: SyncError | null

  isEntitySaving: (entityId: string) => boolean
  isMutationPending: (mutationId: string) => boolean
}

/**
 * Generic hook for CRUD operations on a collection with optimistic updates.
 *
 * Supports three calling conventions:
 *
 * **Single-tenant** — collection only, syncId defaults to `'default'`:
 * @example
 * const { data, add, update, remove } = useCollection<typeof config, 'todos'>('todos')
 *
 * **Single-tenant with options** — skip syncId/scope, pass options directly:
 * @example
 * const { data } = useCollection<typeof config, 'todos'>('todos', { debug: true })
 *
 * **Multi-tenant** — explicit syncId for data isolation:
 * @example
 * const { data } = useCollection<typeof config, 'todos'>('todos', 'user-123')
 *
 * **Multi-tenant with scope** — syncId + scope for sub-filtering:
 * @example
 * const { data } = useCollection<typeof config, 'todos'>('todos', 'project-abc', 'active')
 *
 * **Full control** — all params including options:
 * @example
 * const { data } = useCollection<typeof config, 'todos'>('todos', 'project-abc', 'active', { debug: true })
 *
 * @param collection - Collection name (key from your CollectionsMap)
 * @param syncIdOrOptions - Sync ID for multi-tenant isolation, or options object (syncId defaults to `'default'`)
 * @param scope - Optional scope for sub-filtering within a sync group
 * @param options - Additional configuration (debug, apiPrefix, refetchOnSuccess, etc.)
 */
export function useCollection<
  C extends CollectionsMap,
  K extends keyof C & string
>(
  collection: K,
  syncId?: string,
  scope?: string,
  options?: UseCollectionOptions
): UseCollectionResult<InferEntity<C, K>, Omit<InferInsert<C, K>, 'syncId'>, InferUpdate<C, K>>
export function useCollection<
  C extends CollectionsMap,
  K extends keyof C & string
>(
  collection: K,
  options?: UseCollectionOptions
): UseCollectionResult<InferEntity<C, K>, Omit<InferInsert<C, K>, 'syncId'>, InferUpdate<C, K>>
export function useCollection<
  C extends CollectionsMap,
  K extends keyof C & string
>(
  collection: K,
  syncIdOrOptions?: string | UseCollectionOptions,
  scopeOrUndefined?: string,
  options4?: UseCollectionOptions
): UseCollectionResult<InferEntity<C, K>, Omit<InferInsert<C, K>, 'syncId'>, InferUpdate<C, K>> {
  const isOptionsObject = (val: unknown): val is UseCollectionOptions =>
    typeof val === 'object' && val !== null && !Array.isArray(val)

  const syncId = isOptionsObject(syncIdOrOptions) ? DEFAULT_SYNC_ID : (syncIdOrOptions ?? DEFAULT_SYNC_ID)
  const scope = isOptionsObject(syncIdOrOptions) ? undefined : scopeOrUndefined
  const resolvedOptions = isOptionsObject(syncIdOrOptions) ? syncIdOrOptions : options4
  type Entity = InferEntity<C, K>
  type Insert = Omit<InferInsert<C, K>, 'syncId'>
  type Update = InferUpdate<C, K>

  return useCollectionImpl<Entity, Insert, Update>(
    collection,
    syncId,
    scope,
    resolvedOptions
  ) as UseCollectionResult<Entity, Insert, Update>
}

/**
 * Internal implementation that works with concrete types.
 * Used by both useCollection and createSyncHooks.
 */
function useCollectionImpl<Entity extends { id: string }, Insert, Update>(
  collection: string,
  syncId: string,
  scope: string | undefined,
  options: UseCollectionOptions | undefined
) {
  type MutationContext = {
    previousData: Entity[] | undefined
    optimisticId?: string
    optimisticIds?: string[]
  }

  const apiPrefix = options?.apiPrefix ?? '/api'
  const debug = options?.debug ?? false
  const refetchOnSuccess = options?.refetchOnSuccess ?? false
  const consistentReads = options?.consistentReads ?? false
  const optimisticUpdates = options?.optimisticUpdates ?? true
  const headers = options?.headers

  const getHeaders = useCallback((): Record<string, string> => {
    const base = { 'Content-Type': 'application/json' }
    if (typeof headers === 'function') return { ...base, ...headers() }
    if (headers) return { ...base, ...headers }
    return base
  }, [headers])

  const queryClient = useQueryClient()
  const pendingMutationsRef = useRef<Map<string, PendingMutationInfo>>(new Map())

  const registry = useLiveSyncRegistrySafe()
  const hasLiveSyncForScope = registry?.has(syncId) ?? false

  useEffect(() => {
    if (isDev && !hasLiveSyncForScope) {
      console.warn(
        `[cf-sync-kit] useCollection('${collection}', '${syncId}') is used without ` +
        `useLiveSync('${syncId}') in the component tree.\n` +
        `Realtime updates from other clients will NOT work.\n` +
        `Add useLiveSync('${syncId}') to enable realtime sync.`
      )
    }
  }, [collection, syncId, hasLiveSyncForScope])

  const queryKey: [string, string, string | undefined] = [collection, syncId, scope]

  const log = useCallback((...args: unknown[]) => {
    if (debug) debugLog.debug(`[useCollection:${collection}]`, ...args)
  }, [debug, collection])

  const logError = useCallback((...args: unknown[]) => {
    if (debug) console.error(`[cf-sync-kit] [useCollection:${collection}]`, ...args)
  }, [debug, collection])

  // Shared mutation config
  const retryConfig = {
    retry: (failureCount: number, error: SyncError) => failureCount < 3 && isRetryableError(error),
    retryDelay,
  }

  const makeOnError = useCallback(
    (label: string) => (err: SyncError, _variables: any, context?: MutationContext) => {
      if (context?.previousData) {
        queryClient.setQueryData(queryKey, context.previousData)
      }
      logError(`${label} error:`, err)
    },
    [queryClient, queryKey, logError]
  )

  const makeOnSettled = useCallback(
    () => (_data: any, _error: any, variables: { _clientMutationId: string }) => {
      pendingMutationsRef.current.delete(variables._clientMutationId)
      if (refetchOnSuccess) {
        queryClient.invalidateQueries({ queryKey })
      }
    },
    [pendingMutationsRef, refetchOnSuccess, queryClient, queryKey]
  )

  const query = useQuery<Entity[]>({
    queryKey,
    queryFn: async () => {
      log('Fetching data...')
      const path = consistentReads
        ? `/${syncId}/${collection}?consistent=true`
        : `/${syncId}/${collection}`

      const data = await apiFetch<Record<string, Entity[]>>(path, apiPrefix, { headers: getHeaders() })
      return (data[collection] ?? []) as Entity[]
    }
  })

  const add = useMutation<
    { success: boolean; data: Entity },
    SyncError,
    { data: Insert; _clientMutationId: string },
    MutationContext
  >({
    mutationFn: async (vars) => {
      const { _clientMutationId, data } = vars
      const body = { ...data, _clientMutationId, ...(scope !== undefined && { scope }) }
      return apiFetch<{ success: boolean; data: Entity }>(`/${syncId}/${collection}`, apiPrefix, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body),
      })
    },
    ...retryConfig,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey })
      const previousData = queryClient.getQueryData<Entity[]>(queryKey)
      const optimisticId = (variables.data as any).id ?? crypto.randomUUID()
      pendingMutationsRef.current.set(variables._clientMutationId, { action: 'insert', entityId: optimisticId })
      if (optimisticUpdates) {
        const optimisticEntity = { ...variables.data, id: optimisticId } as unknown as Entity
        queryClient.setQueryData<Entity[]>(queryKey, (old) => [optimisticEntity, ...(old ?? [])])
        log('Optimistic add:', variables.data)
        return { previousData, optimisticId: optimisticEntity.id }
      }
      log('Pessimistic add (waiting for server):', variables.data)
      return { previousData }
    },
    onSuccess: (result, _variables, context) => {
      const entity = result.data
      if (!entity) return
      applyMutationToCache(
        queryClient, collection, syncId, scope, 'insert', entity,
        undefined,
        context?.optimisticId ? [context.optimisticId] : undefined
      )
      log('Add success:', entity)
    },
    onError: makeOnError('Add'),
    onSettled: makeOnSettled(),
  })

  const update = useMutation<
    { success: boolean; data: Entity },
    SyncError,
    { id: string; data: Update; _clientMutationId: string },
    MutationContext
  >({
    mutationFn: async (vars) => {
      const { id, data, _clientMutationId } = vars
      return apiFetch<{ success: boolean; data: Entity }>(`/${syncId}/${collection}/${id}`, apiPrefix, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify({ ...(data as object), _clientMutationId, ...(scope !== undefined && { scope }) }),
      })
    },
    ...retryConfig,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey })
      const previousData = queryClient.getQueryData<Entity[]>(queryKey)
      pendingMutationsRef.current.set(variables._clientMutationId, { entityId: variables.id, action: 'update' })
      if (optimisticUpdates) {
        queryClient.setQueryData<Entity[]>(
          queryKey,
          (oldData) => {
            if (!oldData) return []
            return oldData.map((item) =>
              item.id === variables.id ? { ...item, ...variables.data } : item
            )
          }
        )
        log('Optimistic update:', variables.id, variables.data)
      } else {
        log('Pessimistic update (waiting for server):', variables.id)
      }
      return { previousData }
    },
    onSuccess: (result) => {
      const entity = result.data
      if (!entity) return
      applyMutationToCache(queryClient, collection, syncId, scope, 'update', entity)
      log('Update success:', entity)
    },
    onError: makeOnError('Update'),
    onSettled: makeOnSettled(),
  })

  const remove = useMutation<
    { success: boolean },
    SyncError,
    { id: string; _clientMutationId: string },
    MutationContext
  >({
    mutationFn: async (vars) => {
      const { id, _clientMutationId } = vars
      const params = new URLSearchParams()
      params.set('_clientMutationId', _clientMutationId)
      if (scope !== undefined) params.set('scope', scope)
      return apiFetch<{ success: boolean }>(`/${syncId}/${collection}/${id}?${params.toString()}`, apiPrefix, {
        method: 'DELETE',
        headers: getHeaders(),
      })
    },
    ...retryConfig,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey })
      const previousData = queryClient.getQueryData<Entity[]>(queryKey)
      pendingMutationsRef.current.set(variables._clientMutationId, { entityId: variables.id, action: 'delete' })
      if (optimisticUpdates) {
        queryClient.setQueryData<Entity[]>(
          queryKey,
          (oldData) => {
            if (!oldData) return []
            return oldData.filter((item) => item.id !== variables.id)
          }
        )
        log('Optimistic remove:', variables.id)
      } else {
        log('Pessimistic remove (waiting for server):', variables.id)
      }
      return { previousData }
    },
    onSuccess: (_result, variables) => {
      applyMutationToCache(queryClient, collection, syncId, scope, 'delete', { id: variables.id })
      log('Remove success:', variables.id)
    },
    onError: makeOnError('Remove'),
    onSettled: makeOnSettled(),
  })

  const addManyMutation = useMutation<
    { success: true; data: Entity[] },
    SyncError,
    { items: Insert[]; _clientMutationId: string },
    MutationContext
  >({
    mutationFn: async (vars) => {
      const { items, _clientMutationId } = vars
      const body = { items, _clientMutationId, ...(scope !== undefined && { scope }) }
      return apiFetch<{ success: true; data: Entity[] }>(`/${syncId}/${collection}/bulk`, apiPrefix, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify(body),
      })
    },
    ...retryConfig,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey })
      const previousData = queryClient.getQueryData<Entity[]>(queryKey)
      pendingMutationsRef.current.set(variables._clientMutationId, { action: 'bulk-insert' })
      if (optimisticUpdates) {
        const optimisticEntities = variables.items.map(item => ({ ...item, id: (item as any).id ?? crypto.randomUUID() })) as unknown as Entity[]
        queryClient.setQueryData<Entity[]>(queryKey, (old) => [...optimisticEntities, ...(old ?? [])])
        return { previousData, optimisticIds: optimisticEntities.map(e => e.id) }
      }
      return { previousData }
    },
    onSuccess: (result, _variables, context) => {
      applyMutationToCache(
        queryClient, collection, syncId, scope, 'bulk-insert', result.data,
        undefined,
        context?.optimisticIds
      )
    },
    onError: makeOnError('AddMany'),
    onSettled: makeOnSettled(),
  })

  const updateManyMutation = useMutation<
    { success: true; data: Entity[] },
    SyncError,
    { items: { id: string; data: Update }[]; _clientMutationId: string },
    MutationContext
  >({
    mutationFn: async (vars) => {
      const { items, _clientMutationId } = vars
      const body = { items, _clientMutationId, ...(scope !== undefined && { scope }) }
      return apiFetch<{ success: true; data: Entity[] }>(`/${syncId}/${collection}/bulk`, apiPrefix, {
        method: 'PUT',
        headers: getHeaders(),
        body: JSON.stringify(body),
      })
    },
    ...retryConfig,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey })
      const previousData = queryClient.getQueryData<Entity[]>(queryKey)
      pendingMutationsRef.current.set(variables._clientMutationId, { action: 'bulk-update' })
      if (optimisticUpdates) {
        queryClient.setQueryData<Entity[]>(queryKey, (old) => {
          if (!old) return []
          const updatesMap = new Map(variables.items.map(item => [item.id, item.data]))
          return old.map(item => {
            const update = updatesMap.get(item.id)
            return update ? { ...item, ...update } : item
          })
        })
      }
      return { previousData }
    },
    onSuccess: (result) => {
      if (!result.data?.length) return
      applyMutationToCache(queryClient, collection, syncId, scope, 'bulk-update', result.data)
    },
    onError: makeOnError('UpdateMany'),
    onSettled: makeOnSettled(),
  })

  const removeManyMutation = useMutation<
    { success: true },
    SyncError,
    { ids: string[]; _clientMutationId: string },
    MutationContext
  >({
    mutationFn: async (vars) => {
      const { ids, _clientMutationId } = vars
      const body = { ids, _clientMutationId, ...(scope !== undefined && { scope }) }
      return apiFetch<{ success: true }>(`/${syncId}/${collection}/bulk`, apiPrefix, {
        method: 'DELETE',
        headers: getHeaders(),
        body: JSON.stringify(body),
      })
    },
    ...retryConfig,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey })
      const previousData = queryClient.getQueryData<Entity[]>(queryKey)
      pendingMutationsRef.current.set(variables._clientMutationId, { action: 'bulk-delete' })
      if (optimisticUpdates) {
        const idsToDelete = new Set(variables.ids)
        queryClient.setQueryData<Entity[]>(queryKey, (old) =>
          (old ?? []).filter((item) => !idsToDelete.has(item.id))
        )
      }
      return { previousData }
    },
    onSuccess: (_result, variables) => {
      applyMutationToCache(queryClient, collection, syncId, scope, 'bulk-delete', variables.ids)
    },
    onError: makeOnError('RemoveMany'),
    onSettled: makeOnSettled(),
  })

  const wrapMutate = useCallback(
    <T,>(
      mutate: (vars: any, options?: any) => void,
      buildVars: (payload: T) => any
    ) => (payload: T, options?: any) =>
      mutate({ ...buildVars(payload), _clientMutationId: crypto.randomUUID() }, options),
    []
  )

  const addWithId = wrapMutate(
    add.mutate,
    (payload: Insert) => ({ data: payload })
  )

  const updateWithId = wrapMutate(
    update.mutate,
    (vars: { id: string; data: Update }) => vars
  )

  const removeWithId = wrapMutate(
    remove.mutate,
    (id: string) => ({ id })
  )

  const addMany = wrapMutate(
    addManyMutation.mutate,
    (payloads: Insert[]) => ({ items: payloads })
  )

  const updateMany = wrapMutate(
    updateManyMutation.mutate,
    (payloads: { id: string; data: Update }[]) => ({ items: payloads })
  )

  const removeMany = wrapMutate(
    removeManyMutation.mutate,
    (ids: string[]) => ({ ids })
  )

  return {
    data: (query.data ?? []) as Entity[],
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
    queryKey,

    add: addWithId,
    isAdding: add.isPending,
    addError: add.error,

    update: updateWithId,
    isUpdating: update.isPending,
    updateError: update.error,

    remove: removeWithId,
    isRemoving: remove.isPending,
    removeError: remove.error,

    addMany,
    isAddingMany: addManyMutation.isPending,
    addManyError: addManyMutation.error,

    updateMany,
    isUpdatingMany: updateManyMutation.isPending,
    updateManyError: updateManyMutation.error,

    removeMany,
    isRemovingMany: removeManyMutation.isPending,
    removeManyError: removeManyMutation.error,

    isEntitySaving: (entityId: string) =>
      Array.from(pendingMutationsRef.current.values()).some(m => m.entityId === entityId),

    isMutationPending: (id: string) => pendingMutationsRef.current.has(id),
  }
}
