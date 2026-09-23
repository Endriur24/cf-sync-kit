import { useRef, useCallback, useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import usePartySocket from "partysocket/react"
import {
  WsEventSchema,
  type WsBroadcastEvent,
} from "../../shared/events"
import { applyMutationToCache } from "./cacheUpdater"
import { useConnectionStatus, useLiveSyncRegistry } from "../context/ConnectionContext"
import { SyncError, DEFAULT_SYNC_ID } from "../../shared/types"
import { log } from "../../shared/logger"
import { emitObservabilityEvent } from "../../shared/observability"

/**
 * Configuration options for useLiveSync.
 * Extends PartySocket options for full WebSocket configurability.
 */
export interface UseLiveSyncOptions {
  /** @deprecated Broadcasts are synchronized across all cached scopes in the syncId room. */
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
  /** Interval in ms between application-level liveness probes (default: 20000; set to 0 to disable). */
  heartbeatInterval?: number
  /** Time in ms to wait for a pong before forcing a reconnect (default: 10000). */
  heartbeatTimeout?: number
  /**
   * Move updated items to the top of the collection list in client cache.
   */
  reorderOnUpdate?: boolean
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
 * @param syncId - Sync ID (also used as the WebSocket room name). Optional for single-tenant apps (default: 'default')
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

  const {
    scope,
    party = 'main',
    debug = false,
    onError,
    query,
    reorderOnUpdate,
    heartbeatInterval = 20_000,
    heartbeatTimeout = 10_000,
    ...partySocketOptions
  } = options

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

  const syncState = useRef<{ isSyncing: boolean; queue: WsBroadcastEvent[]; timeoutId: ReturnType<typeof setTimeout> | null }>({
    isSyncing: false,
    queue: [],
    timeoutId: null,
  })
  const lastBroadcastIds = useRef<Map<string, number>>(new Map())
  // Invalidates in-flight refetches from an older socket after a disconnect/reconnect.
  const connectionEpoch = useRef(0)
  const heartbeatRef = useRef<{
    intervalId: ReturnType<typeof setInterval> | null
    timeoutId: ReturnType<typeof setTimeout> | null
    awaitingPong: boolean
    probePromise: Promise<boolean> | null
    resolveProbe: ((isAlive: boolean) => void) | null
    start: () => void
    stop: () => void
    acknowledge: () => void
    probeNow: () => Promise<boolean>
  }>({
    intervalId: null,
    timeoutId: null,
    awaitingPong: false,
    probePromise: null,
    resolveProbe: null,
    start: () => {},
    stop: () => {},
    acknowledge: () => {},
    probeNow: async () => false,
  })

  // Cancel and reset the fallback timeout used when sync-init doesn't arrive
  const clearFallbackTimeout = useCallback(() => {
    if (syncState.current.timeoutId) {
      clearTimeout(syncState.current.timeoutId)
      syncState.current.timeoutId = null
    }
  }, [])

  useEffect(() => {
    lastBroadcastIds.current.clear()
    syncState.current.isSyncing = false
    syncState.current.queue = []
    clearFallbackTimeout()
  }, [syncId, clearFallbackTimeout])

  useEffect(() => {
    return () => registry.unregister(syncId)
  }, [syncId, registry])

  const debugLog = useCallback((...args: unknown[]) => {
    if (debug) log.debug('[useLiveSync]', ...args)
  }, [debug])

  const reportError = useCallback((error: SyncError) => {
    if (onError) onError(error)
    if (debug) log.error('[useLiveSync]', error.message, error.details)
  }, [onError, debug])

  // Merge incoming into existing; keep existing if incoming is older
  const compareUpdatedAt = useCallback((existing: any, incoming: any) => {
    if (!incoming.updatedAt || !existing.updatedAt) return { ...existing, ...incoming }
    if (new Date(incoming.updatedAt).getTime() < new Date(existing.updatedAt).getTime()) {
      return existing
    }
    return { ...existing, ...incoming }
  }, [])

  const handleBroadcast = useCallback(
    (message: WsBroadcastEvent) => {
      applyMutationToCache(
        queryClient,
        message.collection,
        syncId,
        message.scope,
        message.action,
        message.payload,
        compareUpdatedAt,
        undefined,
        { reorderOnUpdate }
      )
    },
    [syncId, queryClient, compareUpdatedAt, reorderOnUpdate]
  )

  const refetchForRecovery = useCallback(async () => {
    await queryClient.refetchQueries({
      predicate: (query) => {
        const [_collection, qSyncId] = query.queryKey as [string, string, string | undefined]
        return qSyncId === syncId
      },
    })
  }, [queryClient, syncId])

  const finishSync = useCallback(async (
    counters?: Record<string, number>,
    expectedEpoch = connectionEpoch.current,
  ) => {
    let isHealthy = false
    try {
      await refetchForRecovery()
      isHealthy = true
      debugLog('Refetch complete')
    } catch (e) {
      reportError(new SyncError('Failed to refetch queries during sync', 'REFETCH_ERROR', undefined, e))
    }

    // Never let a stale recovery overwrite the status or queue of a newer socket.
    if (expectedEpoch !== connectionEpoch.current) return false

    // Update counters only after the epoch guard so a slow recovery from a
    // previous connection cannot destroy counters set by a newer one.
    // When counters is undefined (e.g. resume/timeout) we keep existing
    // counters — gap-detection will handle any discrepancies.
    if (counters) {
      lastBroadcastIds.current.clear()
      Object.entries(counters).forEach(([collection, count]) => {
        lastBroadcastIds.current.set(collection, count)
      })
    }

    clearFallbackTimeout()
    syncState.current.isSyncing = false
    syncState.current.queue.forEach(handleBroadcast)
    syncState.current.queue = []
    return isHealthy
  }, [clearFallbackTimeout, debugLog, handleBroadcast, refetchForRecovery, reportError])

  const completeSync = useCallback(async (
    counters?: Record<string, number>,
    expectedEpoch = connectionEpoch.current,
  ) => {
    const isHealthy = await finishSync(counters, expectedEpoch)
    if (expectedEpoch === connectionEpoch.current) {
      setStatus(syncId, isHealthy ? 'connected' : 'degraded')
    }
    return isHealthy
  }, [finishSync, setStatus, syncId])

  const socket = usePartySocket({
    room: syncId,
    party,
    // Pass function reference so query params are re-evaluated on each reconnect
    // This enables token rotation without requiring a full component remount
    query: getQuery,

    // Pass all PartySocket options (path, host, protocol, reconnection settings, etc.)
    ...partySocketOptions,

    onOpen: () => {
      const currentEpoch = ++connectionEpoch.current
      debugLog('Connected')
      setStatus(syncId, 'synchronizing')
      heartbeatRef.current.start()
      // Discard any messages queued during the previous connection — they are
      // stale and would bypass broadcastId validation when replayed.
      syncState.current.queue = []
      // Prevent race condition: messages arriving before sync-init
      // are queued until counters are received and refetch completes
      syncState.current.isSyncing = true

      // Fallback timeout: if sync-init doesn't arrive within 5s, unblock message processing
      clearFallbackTimeout()
      syncState.current.timeoutId = setTimeout(() => {
        if (syncState.current.isSyncing) {
          debugLog('Sync-init timeout — refetching before unblocking message processing')
          void completeSync(undefined, currentEpoch)
        }
      }, 5000)
    },

    onMessage: async (event) => {
      const messageEpoch = connectionEpoch.current
      heartbeatRef.current.acknowledge()
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
        await completeSync(message.counters, messageEpoch)
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

      // No counter support — apply immediately
      if (message.broadcastId === undefined) {
        handleBroadcast(message)
        debugLog('Applied message without broadcastId:', message.action, message.collection)
        return
      }

      if (message.broadcastId <= lastId) {
        debugLog('Ignored old/duplicate message for', message.collection, '(id:', message.broadcastId, ')')
        return
      }

      if (message.broadcastId > lastId + 1) {
        debugLog(
          `Gap in broadcasts for ${message.collection} (expected ${lastId + 1}, got ${message.broadcastId}), refetching`
        )
        const recoveryStartedAt = Date.now()
        emitObservabilityEvent({
          level: 'warn',
          event: 'sync.gap.detected',
          component: 'client',
          collection: message.collection,
          syncId,
          broadcastId: message.broadcastId,
          stage: 'recovery',
        })
        try {
          await queryClient.refetchQueries({
            predicate: (query) => {
              const [qCollection, qSyncId] = query.queryKey
              return qCollection === message.collection && qSyncId === syncId
            },
          })
          emitObservabilityEvent({
            level: 'info',
            event: 'sync.gap.recovered',
            component: 'client',
            collection: message.collection,
            syncId,
            broadcastId: message.broadcastId,
            durationMs: Date.now() - recoveryStartedAt,
            outcome: 'success',
            stage: 'recovery',
          })
        } catch (e) {
          emitObservabilityEvent({
            level: 'error',
            event: 'sync.gap.recovered',
            component: 'client',
            collection: message.collection,
            syncId,
            broadcastId: message.broadcastId,
            durationMs: Date.now() - recoveryStartedAt,
            outcome: 'failure',
            stage: 'recovery',
          })
          reportError(new SyncError('Failed to refetch queries after broadcast gap', 'REFETCH_ERROR', undefined, e))
        }
      } else {
        handleBroadcast(message)
        debugLog('Applied broadcast:', message.action, message.collection)
      }

      // Guard: do not update counters if a reconnect occurred during async refetch
      if (messageEpoch === connectionEpoch.current) {
        lastBroadcastIds.current.set(message.collection, message.broadcastId)
      }
    },

    onClose: () => {
      connectionEpoch.current++
      heartbeatRef.current.stop()
      debugLog('Disconnected')
      setStatus(syncId, 'reconnecting')
    },
    // Defensively duplicate the epoch bump and status update from onClose.
    // Native WebSocket fires onclose after onerror, but PartySocket wraps
    // the transport, so we don't rely on that ordering. A double epoch bump
    // is safe because the epoch is only used to invalidate stale async work;
    // stop() and setStatus() are true no-ops on repeated calls.
    onError: (e) => {
      connectionEpoch.current++
      heartbeatRef.current.stop()
      debugLog('WebSocket error:', e)
      setStatus(syncId, 'reconnecting')
      reportError(new SyncError('WebSocket connection error', 'WS_ERROR', undefined, e))
    },
  })

  useEffect(() => {
    const stop = () => {
      if (heartbeatRef.current.intervalId) clearInterval(heartbeatRef.current.intervalId)
      if (heartbeatRef.current.timeoutId) clearTimeout(heartbeatRef.current.timeoutId)
      heartbeatRef.current.intervalId = null
      heartbeatRef.current.timeoutId = null
      heartbeatRef.current.awaitingPong = false
      heartbeatRef.current.resolveProbe?.(false)
      heartbeatRef.current.resolveProbe = null
      heartbeatRef.current.probePromise = null
    }

    const acknowledge = () => {
      if (heartbeatRef.current.timeoutId) clearTimeout(heartbeatRef.current.timeoutId)
      heartbeatRef.current.timeoutId = null
      heartbeatRef.current.awaitingPong = false
      heartbeatRef.current.resolveProbe?.(true)
      heartbeatRef.current.resolveProbe = null
      heartbeatRef.current.probePromise = null
    }

    const probe = () => {
      if (heartbeatRef.current.awaitingPong) return heartbeatRef.current.probePromise ?? Promise.resolve(false)
      if (socket.readyState !== socket.OPEN) return Promise.resolve(false)
      heartbeatRef.current.awaitingPong = true
      socket.send('ping')
      heartbeatRef.current.probePromise = new Promise<boolean>((resolve) => {
        heartbeatRef.current.resolveProbe = resolve
      })
      heartbeatRef.current.timeoutId = setTimeout(() => {
        if (!heartbeatRef.current.awaitingPong) return
        debugLog('Heartbeat timeout — forcing reconnect')
        heartbeatRef.current.resolveProbe?.(false)
        heartbeatRef.current.resolveProbe = null
        heartbeatRef.current.probePromise = null
        // PartySocket.close() disables reconnection; reconnect() preserves its retry policy.
        socket.reconnect(4000, 'heartbeat timeout')
      }, heartbeatTimeout)
      return heartbeatRef.current.probePromise
    }

    const start = () => {
      stop()
      if (heartbeatInterval <= 0) return
      heartbeatRef.current.intervalId = setInterval(probe, heartbeatInterval)
    }

    heartbeatRef.current = { ...heartbeatRef.current, start, stop, acknowledge, probeNow: probe }
    return stop
  }, [socket, heartbeatInterval, heartbeatTimeout, debugLog])

  useEffect(() => {
    const recoverAfterResume = () => {
      if (socket.readyState === socket.OPEN) {
        // A tab may have missed broadcasts while suspended even if the transport survived.
        if (!syncState.current.isSyncing) {
          debugLog('Resumed — verifying connection and refreshing data')
          syncState.current.isSyncing = true
          setStatus(syncId, 'synchronizing')
          const expectedEpoch = connectionEpoch.current
          void Promise.all([
            finishSync(undefined, expectedEpoch),
            heartbeatRef.current.probeNow(),
          ]).then(([isHealthy, isAlive]) => {
            if (expectedEpoch !== connectionEpoch.current) return
            if (!isAlive) {
              // Probe failed — socket is dead. reconnect() was already called
              // inside probe, but set the status explicitly so the UI doesn't
              // stay on 'synchronizing' until onClose fires.
              setStatus(syncId, 'reconnecting')
              return
            }
            setStatus(syncId, isHealthy ? 'connected' : 'degraded')
          })
          return
        }
        // Already syncing — just verify the transport is alive.
        void heartbeatRef.current.probeNow().then((isAlive) => {
          if (!isAlive) setStatus(syncId, 'reconnecting')
        })
        return
      }

      debugLog('Resumed without an open socket — reconnecting')
      setStatus(syncId, 'reconnecting')
      socket.reconnect(4000, 'network resumed')
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') recoverAfterResume()
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) recoverAfterResume()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', recoverAfterResume)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('online', recoverAfterResume)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [debugLog, finishSync, setStatus, socket, syncId])
}
