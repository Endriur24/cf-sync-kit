/**
 * @vitest-environment jsdom
 *
 * Integration tests for useLiveSync that exercise the real hook with a
 * mocked PartySocket transport. Unlike the unit tests in
 * useLiveSync-logic.test.ts, these mount the hook inside a React tree
 * and will catch regressions where the production code diverges from the
 * tested invariants.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { ConnectionProvider, useConnectionStatus } from '../client/context/ConnectionContext'
import { useLiveSync } from '../client/hooks/useLiveSync'
import { configureObservability, type ObservabilityEvent } from '../shared/observability'

// ---------------------------------------------------------------------------
// Mock for partysocket/react
// ---------------------------------------------------------------------------

interface MockSocketInstance {
  handlers: {
    onOpen: () => void
    onClose: () => void
    onError: (e: Event) => void
    onMessage: (event: MessageEvent) => void
  }
  socket: {
    readyState: number
    OPEN: number
    send: ReturnType<typeof vi.fn>
    reconnect: ReturnType<typeof vi.fn>
  }
}

const socketsByRoom = new Map<string, MockSocketInstance>()
let lastCapturedRoom = 'default'

function getRoomSocket(room = lastCapturedRoom): MockSocketInstance {
  const instance = socketsByRoom.get(room)
  if (!instance) {
    throw new Error(`No socket captured for room: ${room}`)
  }
  return instance
}

const WS_OPEN = 1

vi.mock('partysocket/react', () => ({
  default: (opts: any) => {
    const room = opts.room ?? 'default'
    lastCapturedRoom = room
    let instance = socketsByRoom.get(room)
    if (!instance) {
      instance = {
        handlers: {
          onOpen: () => {},
          onClose: () => {},
          onError: () => {},
          onMessage: () => {},
        },
        socket: {
          readyState: WS_OPEN,
          OPEN: WS_OPEN,
          send: vi.fn(),
          reconnect: vi.fn(),
        },
      }
      socketsByRoom.set(room, instance)
    }
    instance.handlers.onOpen = opts.onOpen ?? (() => {})
    instance.handlers.onClose = opts.onClose ?? (() => {})
    instance.handlers.onError = opts.onError ?? (() => {})
    instance.handlers.onMessage = opts.onMessage ?? (() => {})
    return instance.socket
  },
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ConnectionProvider, null, children),
    )
  }

  return { Wrapper, queryClient }
}

function syncInitMessage(counters: Record<string, number> = {}) {
  return new MessageEvent('message', {
    data: JSON.stringify({ type: 'sync-init', counters }),
  })
}

function broadcastMessage(
  collection: string,
  action: string,
  payload: unknown,
  broadcastId?: number,
  scope?: string,
) {
  return new MessageEvent('message', {
    data: JSON.stringify({ type: 'broadcast', collection, action, payload, broadcastId, scope }),
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useLiveSync integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    socketsByRoom.clear()
  })

  afterEach(() => {
    configureObservability()
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // -----------------------------------------------------------------------
  // Scenario 1: onOpen → sync-init → refetch → connected
  // -----------------------------------------------------------------------
  it('transitions to connected after onOpen + sync-init', async () => {
    const { Wrapper, queryClient } = createWrapper()

    // Seed a query so refetchQueries has something to refetch
    queryClient.setQueryData(['todos', 'room-1', undefined], [{ id: '1', title: 'test' }])

    const { result } = renderHook(
      () => ({
        sync: useLiveSync('room-1'),
        connection: useConnectionStatus(),
      }),
      { wrapper: Wrapper },
    )

    const room = getRoomSocket('room-1')

    // Before onOpen: status should be connecting (no socket event yet)
    expect(result.current.connection.status).toBe('connecting')

    // Simulate WebSocket open
    await act(async () => {
      room.handlers.onOpen()
    })
    expect(result.current.connection.status).toBe('synchronizing')

    // Simulate sync-init from server
    await act(async () => {
      await room.handlers.onMessage(syncInitMessage({ todos: 5 }))
    })

    expect(result.current.connection.status).toBe('connected')
  })

  // -----------------------------------------------------------------------
  // Scenario 2: onError without waiting for onClose sets reconnecting
  // -----------------------------------------------------------------------
  it('sets reconnecting on onError even if onClose has not fired yet', async () => {
    const { Wrapper, queryClient } = createWrapper()
    queryClient.setQueryData(['todos', 'room-1', undefined], [])

    const { result } = renderHook(
      () => ({
        sync: useLiveSync('room-1'),
        connection: useConnectionStatus(),
      }),
      { wrapper: Wrapper },
    )

    const room = getRoomSocket('room-1')

    // Get to connected state
    await act(async () => {
      room.handlers.onOpen()
      await room.handlers.onMessage(syncInitMessage({ todos: 0 }))
    })
    expect(result.current.connection.status).toBe('connected')

    // Fire onError WITHOUT onClose
    await act(async () => {
      room.handlers.onError(new Event('error'))
    })

    // Status must already be reconnecting — not stuck on connected
    expect(result.current.connection.status).toBe('reconnecting')

    // onClose follows — status remains reconnecting (idempotent)
    await act(async () => {
      room.handlers.onClose()
    })
    expect(result.current.connection.status).toBe('reconnecting')
  })

  // -----------------------------------------------------------------------
  // Scenario 3: Reconnect does not replay stale queue
  // -----------------------------------------------------------------------
  it('does not replay broadcasts from a previous connection after reconnect', async () => {
    const { Wrapper, queryClient } = createWrapper()
    queryClient.setQueryData(['todos', 'room-1', undefined], [])

    renderHook(() => useLiveSync('room-1'), { wrapper: Wrapper })

    const room = getRoomSocket('room-1')

    // Connection 1: open, no sync-init yet (isSyncing=true), broadcast arrives → queued
    await act(async () => {
      room.handlers.onOpen()
    })

    await act(async () => {
      await room.handlers.onMessage(
        broadcastMessage('todos', 'insert', { id: 'stale-item', title: 'stale' }, 1),
      )
    })

    // Disconnect and reconnect
    await act(async () => {
      room.handlers.onClose()
    })
    await act(async () => {
      room.handlers.onOpen()
    })

    // sync-init for connection 2 — should NOT replay the stale insert
    await act(async () => {
      await room.handlers.onMessage(syncInitMessage({ todos: 10 }))
    })

    const data = queryClient.getQueryData<any[]>(['todos', 'room-1', undefined])
    const hasStale = data?.some((item: any) => item.id === 'stale-item')
    expect(hasStale).toBe(false)
  })

  // -----------------------------------------------------------------------
  // Scenario 4: visibilitychange → probe → reconnect when probe fails
  // -----------------------------------------------------------------------
  it('transitions to reconnecting when visibility probe fails', async () => {
    const { Wrapper, queryClient } = createWrapper()
    queryClient.setQueryData(['todos', 'room-1', undefined], [])

    const { result } = renderHook(
      () => ({
        sync: useLiveSync('room-1', { heartbeatTimeout: 500 }),
        connection: useConnectionStatus(),
      }),
      { wrapper: Wrapper },
    )

    const room = getRoomSocket('room-1')

    // Get to connected state
    await act(async () => {
      room.handlers.onOpen()
      await room.handlers.onMessage(syncInitMessage({ todos: 0 }))
    })
    expect(result.current.connection.status).toBe('connected')

    // Simulate tab becoming visible again
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    // A ping should have been sent
    expect(room.socket.send).toHaveBeenCalledWith('ping')

    // No pong arrives — heartbeat timeout fires
    await act(async () => {
      vi.advanceTimersByTime(600)
    })

    // Socket should be told to reconnect
    expect(room.socket.reconnect).toHaveBeenCalled()
    expect(result.current.connection.status).toBe('reconnecting')
  })

  // -----------------------------------------------------------------------
  // Scenario 5: visibilitychange → probe succeeds → connected
  // -----------------------------------------------------------------------
  it('returns to connected when visibility probe succeeds', async () => {
    const { Wrapper, queryClient } = createWrapper()
    queryClient.setQueryData(['todos', 'room-1', undefined], [])

    const { result } = renderHook(
      () => ({
        sync: useLiveSync('room-1', { heartbeatTimeout: 500 }),
        connection: useConnectionStatus(),
      }),
      { wrapper: Wrapper },
    )

    const room = getRoomSocket('room-1')

    // Get to connected state
    await act(async () => {
      room.handlers.onOpen()
      await room.handlers.onMessage(syncInitMessage({ todos: 0 }))
    })
    expect(result.current.connection.status).toBe('connected')

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    })

    // Simulate tab becoming visible
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(result.current.connection.status).toBe('synchronizing')
    expect(room.socket.send).toHaveBeenCalledWith('ping')

    // Pong arrives (server auto-response)
    await act(async () => {
      await room.handlers.onMessage(new MessageEvent('message', { data: 'pong' }))
    })

    expect(result.current.connection.status).toBe('connected')
    expect(room.socket.reconnect).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // Scenario 6: Browser online and BFCache pageshow events trigger recovery
  // -----------------------------------------------------------------------
  it('recovers after browser online event and pageshow with persisted: true', async () => {
    const { Wrapper, queryClient } = createWrapper()
    queryClient.setQueryData(['todos', 'room-1', undefined], [])

    const { result } = renderHook(
      () => ({
        sync: useLiveSync('room-1', { heartbeatTimeout: 500 }),
        connection: useConnectionStatus(),
      }),
      { wrapper: Wrapper },
    )

    const room = getRoomSocket('room-1')

    // Connect
    await act(async () => {
      room.handlers.onOpen()
      await room.handlers.onMessage(syncInitMessage({ todos: 0 }))
    })
    expect(result.current.connection.status).toBe('connected')

    // Online event triggers probe + sync
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    expect(result.current.connection.status).toBe('synchronizing')
    expect(room.socket.send).toHaveBeenCalledWith('ping')

    await act(async () => {
      await room.handlers.onMessage(new MessageEvent('message', { data: 'pong' }))
    })
    expect(result.current.connection.status).toBe('connected')

    // BFCache pageshow event (persisted: true)
    const pageShowEvent = new Event('pageshow') as any
    pageShowEvent.persisted = true
    await act(async () => {
      window.dispatchEvent(pageShowEvent)
    })
    expect(result.current.connection.status).toBe('synchronizing')

    await act(async () => {
      await room.handlers.onMessage(new MessageEvent('message', { data: 'pong' }))
    })
    expect(result.current.connection.status).toBe('connected')
  })

  // -----------------------------------------------------------------------
  // Scenario 7: Query refetch failure during sync sets status to degraded
  // -----------------------------------------------------------------------
  it('sets status to degraded when refetchQueries fails during sync-init', async () => {
    const { Wrapper, queryClient } = createWrapper()
    const onError = vi.fn()

    // Spy on refetchQueries to make it throw
    vi.spyOn(queryClient, 'refetchQueries').mockRejectedValueOnce(new Error('Refetch failed'))

    const { result } = renderHook(
      () => ({
        sync: useLiveSync('room-1', { onError }),
        connection: useConnectionStatus(),
      }),
      { wrapper: Wrapper },
    )

    const room = getRoomSocket('room-1')

    await act(async () => {
      room.handlers.onOpen()
    })
    expect(result.current.connection.status).toBe('synchronizing')

    await act(async () => {
      await room.handlers.onMessage(syncInitMessage({ todos: 5 }))
    })

    expect(result.current.connection.status).toBe('degraded')
    expect(result.current.connection.isDegraded).toBe(true)
    expect(onError).toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // Scenario 8: Multi-room status aggregation
  // -----------------------------------------------------------------------
  it('correctly manages multi-room connection states and aggregated status', async () => {
    const { Wrapper, queryClient } = createWrapper()
    queryClient.setQueryData(['todos', 'room-A', undefined], [])
    queryClient.setQueryData(['todos', 'room-B', undefined], [])

    const { result } = renderHook(
      () => {
        useLiveSync('room-A')
        useLiveSync('room-B')
        return useConnectionStatus()
      },
      { wrapper: Wrapper },
    )

    const roomA = getRoomSocket('room-A')
    const roomB = getRoomSocket('room-B')

    // Both connecting
    expect(result.current.status).toBe('connecting')

    // Connect room-A only
    await act(async () => {
      roomA.handlers.onOpen()
      await roomA.handlers.onMessage(syncInitMessage({ todos: 0 }))
    })

    // room-A is connected, room-B is not yet connected -> aggregate status is connecting
    expect(result.current.roomStatuses['room-A']).toBe('connected')
    expect(result.current.status).toBe('connecting')

    // Room-B opens (synchronizing) -> aggregate status is synchronizing
    await act(async () => {
      roomB.handlers.onOpen()
    })
    expect(result.current.roomStatuses['room-B']).toBe('synchronizing')
    expect(result.current.status).toBe('synchronizing')

    // Finish connecting room-B with sync-init
    await act(async () => {
      await roomB.handlers.onMessage(syncInitMessage({ todos: 0 }))
    })

    // Both connected -> aggregate status is connected
    expect(result.current.roomStatuses['room-A']).toBe('connected')
    expect(result.current.roomStatuses['room-B']).toBe('connected')
    expect(result.current.status).toBe('connected')
    expect(result.current.isConnected).toBe(true)

    // Disconnect room-A -> aggregate status becomes reconnecting
    await act(async () => {
      roomA.handlers.onError(new Event('error'))
    })
    expect(result.current.roomStatuses['room-A']).toBe('reconnecting')
    expect(result.current.roomStatuses['room-B']).toBe('connected')
    expect(result.current.status).toBe('reconnecting')
    expect(result.current.isConnected).toBe(false)
  })

  // -----------------------------------------------------------------------
  // Scenario 9: Broadcast updates matching scoped and unscoped caches
  // -----------------------------------------------------------------------
  it('updates unscoped and matching scoped caches even when the hook has another scope', async () => {
    const { Wrapper, queryClient } = createWrapper()
    queryClient.setQueryData(['todos', 'room-1', undefined], [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ])
    queryClient.setQueryData(['todos', 'room-1', 'scope-a'], [{ id: 'a', title: 'A' }])
    queryClient.setQueryData(['todos', 'room-1', 'scope-b'], [{ id: 'b', title: 'B' }])

    renderHook(() => useLiveSync('room-1', { scope: 'scope-a' }), { wrapper: Wrapper })
    const room = getRoomSocket('room-1')

    await act(async () => {
      room.handlers.onOpen()
      await room.handlers.onMessage(syncInitMessage({ todos: 0 }))
      await room.handlers.onMessage(
        broadcastMessage('todos', 'update', { id: 'b', title: 'Updated B' }, 1, 'scope-b'),
      )
    })

    expect(queryClient.getQueryData(['todos', 'room-1', undefined])).toEqual([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'Updated B' },
    ])
    expect(queryClient.getQueryData(['todos', 'room-1', 'scope-a'])).toEqual([{ id: 'a', title: 'A' }])
    expect(queryClient.getQueryData(['todos', 'room-1', 'scope-b'])).toEqual([{ id: 'b', title: 'Updated B' }])
  })

  // -----------------------------------------------------------------------
  // Scenario 10: Broadcast gap detection triggers refetch
  // -----------------------------------------------------------------------
  it('triggers query refetch when a broadcast ID gap is detected', async () => {
    const { Wrapper, queryClient } = createWrapper()
    const telemetry: ObservabilityEvent[] = []
    configureObservability({ sink: event => telemetry.push({ ...event }) })
    queryClient.setQueryData(['todos', 'room-1', undefined], [{ id: '1', title: 'item 1' }])

    const refetchSpy = vi.spyOn(queryClient, 'refetchQueries')

    renderHook(() => useLiveSync('room-1'), { wrapper: Wrapper })
    const room = getRoomSocket('room-1')

    // Connect with counter = 5
    await act(async () => {
      room.handlers.onOpen()
      await room.handlers.onMessage(syncInitMessage({ todos: 5 }))
    })

    refetchSpy.mockClear()

    // Receive message with broadcastId 7 (expected 6 -> gap!)
    await act(async () => {
      await room.handlers.onMessage(
        broadcastMessage('todos', 'update', { id: '1', title: 'gap item' }, 7),
      )
    })

    // Should have triggered refetch for the gap
    const options = refetchSpy.mock.calls[0]?.[0]
    expect(options).toEqual({ predicate: expect.any(Function) })
    expect(options?.predicate?.({ queryKey: ['todos', 'room-1', undefined] } as any)).toBe(true)
    expect(options?.predicate?.({ queryKey: ['todos', 'room-1', 'scope-a'] } as any)).toBe(true)
    expect(options?.predicate?.({ queryKey: ['notes', 'room-1', undefined] } as any)).toBe(false)
    expect(options?.predicate?.({ queryKey: ['todos', 'room-2', undefined] } as any)).toBe(false)
    expect(telemetry.map(event => event.event)).toEqual([
      'sync.gap.detected',
      'sync.gap.recovered',
    ])
    expect(telemetry[1]).toMatchObject({
      component: 'client',
      collection: 'todos',
      syncId: 'room-1',
      broadcastId: 7,
      durationMs: expect.any(Number),
      outcome: 'success',
    })
  })

  // -----------------------------------------------------------------------
  // Scenario 10: visibilitychange with readyState !== OPEN forces immediate reconnect
  // -----------------------------------------------------------------------
  it('triggers immediate reconnect when visibilitychange occurs with readyState !== OPEN', async () => {
    const { Wrapper, queryClient } = createWrapper()
    queryClient.setQueryData(['todos', 'room-1', undefined], [])

    const { result } = renderHook(
      () => ({
        sync: useLiveSync('room-1'),
        connection: useConnectionStatus(),
      }),
      { wrapper: Wrapper },
    )

    const room = getRoomSocket('room-1')

    // Simulate socket in non-OPEN readyState (e.g. 3 = CLOSED)
    room.socket.readyState = 3

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    // Should immediately call reconnect and set status to reconnecting without probing
    expect(room.socket.reconnect).toHaveBeenCalledWith(4000, 'network resumed')
    expect(room.socket.send).not.toHaveBeenCalled()
    expect(result.current.connection.status).toBe('reconnecting')
  })

  // -----------------------------------------------------------------------
  // Scenario 11: Cleanup on unmount removes DOM/window listeners
  // -----------------------------------------------------------------------
  it('cleans up window and document event listeners on unmount', async () => {
    const { Wrapper, queryClient } = createWrapper()
    queryClient.setQueryData(['todos', 'room-1', undefined], [])

    const { unmount } = renderHook(() => useLiveSync('room-1'), { wrapper: Wrapper })
    const room = getRoomSocket('room-1')

    // Connect
    await act(async () => {
      room.handlers.onOpen()
      await room.handlers.onMessage(syncInitMessage({ todos: 0 }))
    })

    // Unmount hook
    unmount()
    room.socket.send.mockClear()

    // Dispatch events on document / window after unmount
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('online'))
      const pageShowEvent = new Event('pageshow') as any
      pageShowEvent.persisted = true
      window.dispatchEvent(pageShowEvent)
    })

    // No probe/ping should be sent after unmount
    expect(room.socket.send).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // Scenario 12: Reconnect during gap refetch does not overwrite new session counters
  // -----------------------------------------------------------------------
  it('does not overwrite new session counters if reconnect happens during gap refetch', async () => {
    const { Wrapper, queryClient } = createWrapper()
    queryClient.setQueryData(['todos', 'room-1', undefined], [])

    let resolveSlowRefetch: () => void = () => {}
    const slowRefetchPromise = new Promise<void>((resolve) => {
      resolveSlowRefetch = resolve
    })

    // Pause only for the collection-specific gap predicate. Sync-init recovery
    // matches every collection in the room and should resolve immediately.
    const refetchSpy = vi.spyOn(queryClient, 'refetchQueries').mockImplementation(async (options: any) => {
      if (options?.predicate && !options.predicate({ queryKey: ['notes', 'room-1', undefined] })) {
        await slowRefetchPromise
      }
    })

    renderHook(() => useLiveSync('room-1'), { wrapper: Wrapper })
    const room = getRoomSocket('room-1')

    // Connection 1: connect with counter = 5
    await act(async () => {
      room.handlers.onOpen()
      await room.handlers.onMessage(syncInitMessage({ todos: 5 }))
    })

    // Receive message with gap (broadcastId = 10) -> starts slow refetch
    const messagePromise = room.handlers.onMessage(
      broadcastMessage('todos', 'update', { id: '1', title: 'gap' }, 10),
    )

    // While gap refetch is pending, socket reconnects and session 2 starts with counter = 20
    await act(async () => {
      room.handlers.onClose()
      room.handlers.onOpen()
      await room.handlers.onMessage(syncInitMessage({ todos: 20 }))
    })

    // Now complete the slow refetch from connection 1
    await act(async () => {
      resolveSlowRefetch()
      await messagePromise
    })

    // Connection 2's counter (20) should NOT have been overwritten by stale message 10
    // Send a message with broadcastId 21 (expected 21 -> valid next message)
    refetchSpy.mockClear()
    await act(async () => {
      await room.handlers.onMessage(
        broadcastMessage('todos', 'update', { id: '2', title: 'valid' }, 21),
      )
    })

    // It should have applied without gap detection
    expect(refetchSpy).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // Scenario 13: 5s sync-init timeout fallback refetches and unblocks syncing
  // -----------------------------------------------------------------------
  it('unblocks message processing after 5s sync-init timeout', async () => {
    const { Wrapper, queryClient } = createWrapper()
    queryClient.setQueryData(['todos', 'room-1', undefined], [{ id: '1', title: 'item' }])

    const { result } = renderHook(
      () => ({
        sync: useLiveSync('room-1'),
        connection: useConnectionStatus(),
      }),
      { wrapper: Wrapper },
    )

    const room = getRoomSocket('room-1')

    // Open connection
    await act(async () => {
      room.handlers.onOpen()
    })
    expect(result.current.connection.status).toBe('synchronizing')

    // No sync-init arrives — advance timer by 5000ms
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })

    // Should have transitioned to connected
    expect(result.current.connection.status).toBe('connected')
  })
})
