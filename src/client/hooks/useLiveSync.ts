import { useRef, useCallback, useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import usePartySocket from "partysocket/react"
import {
  WsEventSchema,
  type WsBroadcastEvent,
} from "../../shared/events"
import { useConnectionStatus, useLiveSyncRegistry } from "../context/ConnectionContext"
import { SyncError, DEFAULT_SYNC_ID } from "../../shared/types"
import { log } from "../../shared/logger"

/**
 * Configuration options for useLiveSync.
 * Extends PartySocket options for full WebSocket configurability.
 */
export interface UseLiveSyncOptions {
  /** Optional scope for filtering broadcasts */
  scope?: string
  /** PartyKit party/namespace to connect to (defaults to "main") */
  party?: string
  /** Enable debug logging of WebSocket messages */
  debug?: boolean
  /** Callback for sync errors */
  onError?: (error: Error) => void
  /**
   * Query parameters to append to the WebSocket URL (e.g. for auth tokens).
   * Can be a static object or a function that returns params for each connection.
   */
  query?: Record<string, string> | (() => Record<string, string>)
  /**
   * Custom base path for the WebSocket connection (defaults to "/parties").
   * Allows mounting the PartyKit endpoint on a different path.
   */
  path?: string
  /**
   * Custom host for the WebSocket connection.
   * Useful for connecting to a different server or custom domain.
   */
  host?: string
  /**
   * WebSocket protocol to use ("ws" or "wss").
   */
  protocol?: 'ws' | 'wss'
  /**
   * Maximum delay in ms between reconnection attempts (default: 10000).
   */
  maxReconnectionDelay?: number
  /**
   * Minimum delay in ms between reconnection attempts.
   */
  minReconnectionDelay?: number
  /**
   * How fast the reconnection delay grows (default: 1.3).
   */
  reconnectionDelayGrowFactor?: number
  /**
   * Minimum time in ms to consider connection as stable (default: 5000).
   */
  minUptime?: number
  /**
   * Retry connect if not connected after this time, in ms (default: 4000).
   */
  connectionTimeout?: number
  /**
   * Maximum number of reconnection retries (default: Infinity).
   */
  maxRetries?: number
  /**
   * Maximum number of messages to buffer until reconnection (default: Infinity).
   */
  maxEnqueuedMessages?: number
}

/**
 * Hook that establishes a live WebSocket connection for real-time sync.
 * Listens for broadcast events from the server and applies optimistic updates
 * to the TanStack Query cache.
 *
 * Must be used within a ConnectionProvider and QueryClientProvider.
 *
 * ⚠️  CONNECTION DEDUPLICATION: Each call to useLiveSync creates a separate
 * WebSocket connection. If multiple components in the tree call useLiveSync
 * with the same syncId, multiple connections will be established. The server
 * correctly handles duplicate subscriptions via Set-based registries, but
 * this results in redundant WebSocket connections.
 *
 * Best practice: Call useLiveSync once at the app/layout level for each
 * unique syncId, rather than in individual components.
 *
 * @param syncId - Sync ID (also used as the WebSocket room name). Optional for single-tenant apps (default: '_default')
 * @param optionsOrScope - Options object or scope string (legacy)
 *
 * @example
 * // Multi-tenant
 * useLiveSync('my-project', { party: 'todos', debug: true, onError: console.error })
 *
 * @example
 * // Single-tenant (simplified)
 * useLiveSync()
 */
export function useLiveSync(
  syncId = DEFAULT_SYNC_ID as string,
  optionsOrScope?: UseLiveSyncOptions | string
) {
  const options: UseLiveSyncOptions = typeof optionsOrScope === 'string'
    ? { scope: optionsOrScope }
    : optionsOrScope ?? {}

  const { scope, party = 'main', debug = false, onError, query, ...partySocketOptions } = options

  const getQuery = useCallback((): Record<string, string> => {
    if (typeof query === 'function') {
      return query()
    }
    return query ?? {}
  }, [query])

  const queryClient = useQueryClient()
  const { setStatus } = useConnectionStatus()
  const registry = useLiveSyncRegistry()

  // Register synchronously so useCollection sees it during the same render
  const prevSyncIdRef = useRef<string | null>(null)
  if (prevSyncIdRef.current !== syncId) {
    if (prevSyncIdRef.current !== null) {
      registry.unregister(prevSyncIdRef.current)
    }
    registry.register(syncId)
    prevSyncIdRef.current = syncId
  }
  useEffect(() => {
    lastBroadcastIds.current.clear()
    syncState.current.isSyncing = false
    syncState.current.queue = []
    if (syncState.current.timeoutId) {
      clearTimeout(syncState.current.timeoutId)
      syncState.current.timeoutId = null
    }
  }, [syncId])

  useEffect(() => {
    return () => registry.unregister(syncId)
  }, [syncId, registry])

  const syncState = useRef<{ isSyncing: boolean; queue: WsBroadcastEvent[]; timeoutId: ReturnType<typeof setTimeout> | null }>({
    isSyncing: false,
    queue: [],
    timeoutId: null,
  })
  const lastBroadcastIds = useRef<Map<string, number>>(new Map())

  const debugLog = useCallback((...args: unknown[]) => {
    if (debug) log.debug('[useLiveSync]', ...args)
  }, [debug])

  const reportError = useCallback((error: SyncError) => {
    if (onError) onError(error)
    if (debug) log.error('[useLiveSync]', error.message, error.details)
  }, [onError, debug])

  const compareUpdatedAt = useCallback((existing: any, incoming: any) => {
    if (!incoming.updatedAt || !existing.updatedAt) return Object.assign({}, existing, incoming)
    if (new Date(incoming.updatedAt).getTime() < new Date(existing.updatedAt).getTime()) {
      return existing
    }
    return Object.assign({}, existing, incoming)
  }, [])

  const applyMutationToCache = useCallback(
    (message: WsBroadcastEvent) => {
      if (scope !== undefined && message.scope !== undefined && message.scope !== scope) {
        return
      }

      const collection = message.collection
      const targetScope = message.scope !== undefined ? message.scope : scope
      const payload = message.payload as any

      queryClient.setQueryData<unknown[]>(
        [collection, syncId, targetScope],
        (oldData) => {
          if (!oldData) {
            if (message.action === "insert") return [payload]
            if (message.action === "bulk-insert") return payload as unknown[]
            return []
          }

          switch (message.action) {
            case "insert":
              return (oldData as any[]).some((item) => item.id === payload.id)
                ? oldData
                : [payload, ...oldData]
            case "update":
              return (oldData as any[]).map((item) =>
                item.id === payload.id
                  ? compareUpdatedAt(item, payload)
                  : item
              )
            case "delete":
              return (oldData as any[]).filter((item) => item.id !== payload.id)
            case "bulk-insert": {
              const payloads = payload as any[]
              const existingIds = new Set((oldData as any[]).map(item => item.id))
              const newItems = payloads.filter(p => !existingIds.has(p.id))
              return [...newItems, ...oldData]
            }
            case "bulk-update": {
              const payloads = payload as any[]
              const updatesMap = new Map(payloads.map(p => [p.id, p]))
              return (oldData as any[]).map((item) => {
                const update = updatesMap.get(item.id)
                return update ? compareUpdatedAt(item, update) : item
              })
            }
            case "bulk-delete": {
              const idsArray = Array.isArray(payload) ? payload : payload.ids;
              const idsToDelete = new Set(idsArray);
              return (oldData as any[]).filter((item) => !idsToDelete.has(item.id))
            }
            default:
              return oldData
          }
        }
      )
    },
    [syncId, queryClient, compareUpdatedAt, scope]
  )

  usePartySocket({
    room: syncId,
    party,
    // Pass function reference so query params are re-evaluated on each reconnect
    // This enables token rotation without requiring a full component remount
    query: getQuery,

    // Pass all PartySocket options (path, host, protocol, reconnection settings, etc.)
    ...partySocketOptions,

    onOpen: () => {
      debugLog('Connected')
      setStatus("connected")
      // Prevent race condition: messages arriving before sync-init
      // are queued until counters are received and refetch completes
      syncState.current.isSyncing = true

      // Fallback timeout: if sync-init doesn't arrive within 5s, unblock message processing
      if (syncState.current.timeoutId) clearTimeout(syncState.current.timeoutId)
      syncState.current.timeoutId = setTimeout(() => {
        if (syncState.current.isSyncing) {
          debugLog('Sync-init timeout — unblocking message processing')
          syncState.current.isSyncing = false
          syncState.current.queue.forEach(applyMutationToCache)
          syncState.current.queue = []
        }
      }, 5000)
    },

    onMessage: async (event) => {
      if (event.data === "pong") return

      let rawData: unknown
      try {
        rawData = JSON.parse(event.data as string)
      } catch (e) {
        reportError(new SyncError('Failed to parse WebSocket message', 'PARSE_ERROR', undefined, e))
        return
      }

      const result = WsEventSchema.safeParse(rawData)
      if (!result.success) {
        reportError(new SyncError('WebSocket message failed validation', 'VALIDATION_ERROR', undefined, result.error.issues))
        return
      }

      const message = result.data

      if (message.type === 'error') {
        reportError(new SyncError(message.message, 'SERVER_ERROR'))
        return
      }

      if (message.type === 'sync-init') {
        debugLog('Sync init received, counters:', message.counters)
        syncState.current.isSyncing = true

        lastBroadcastIds.current.clear()
        Object.entries(message.counters).forEach(([collection, count]) => {
          lastBroadcastIds.current.set(collection, count)
        })

        try {
          await queryClient.refetchQueries({
            predicate: (query) => {
              const matchesSyncId = query.queryKey.includes(syncId)
              if (!scope) return matchesSyncId
              return matchesSyncId && query.queryKey.includes(scope)
            },
          })
          debugLog('Refetch complete')
        } catch (e) {
          reportError(new SyncError('Failed to refetch queries during sync', 'REFETCH_ERROR', undefined, e))
        } finally {
          // Clear the fallback timeout
          if (syncState.current.timeoutId) {
            clearTimeout(syncState.current.timeoutId)
            syncState.current.timeoutId = null
          }
          syncState.current.isSyncing = false
          syncState.current.queue.forEach(applyMutationToCache)
          syncState.current.queue = []
        }
        return
      }

      if (message.type !== 'broadcast') return
      if (!message.collection || !message.action) return

      if (syncState.current.isSyncing) {
        debugLog('Queuing message during sync:', message)
        syncState.current.queue.push(message)
        return
      }

      const lastId = lastBroadcastIds.current.get(message.collection) ?? 0

      if (message.broadcastId !== undefined) {
        if (message.broadcastId > lastId) {
          if (message.broadcastId > lastId + 1) {
            debugLog(
              `Gap in broadcasts for ${message.collection} (expected ${lastId + 1}, got ${message.broadcastId}), refetching`
            )
            queryClient.refetchQueries({
              queryKey: [message.collection, syncId, message.scope],
            })
          } else {
            applyMutationToCache(message)
            debugLog('Applied broadcast:', message.action, message.collection)
          }
          lastBroadcastIds.current.set(message.collection, message.broadcastId)
        } else {
          debugLog('Ignored old/duplicate message for', message.collection, '(id:', message.broadcastId, ')')
        }
      } else {
        applyMutationToCache(message)
        debugLog('Applied message without broadcastId:', message.action, message.collection)
      }
    },

    onClose: () => {
      debugLog('Disconnected')
      setStatus("disconnected")
    },
    onError: (e) => {
      debugLog('WebSocket error:', e)
      setStatus("disconnected")
      reportError(new SyncError('WebSocket connection error', 'WS_ERROR', undefined, e))
    },
  })
}
