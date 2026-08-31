import { createContext, useCallback, useContext, useMemo, useState, useRef, type ReactNode } from 'react'
import type { ConnectionStatus } from '../../shared/types'

interface ConnectionContextType {
  status: ConnectionStatus
  /** Aggregate status: connected only when every active room is connected. */
  setStatus: (syncId: string, status: ConnectionStatus) => void
  /** Connection status keyed by syncId, for applications with multiple rooms. */
  roomStatuses: Readonly<Record<string, ConnectionStatus>>
  isConnected: boolean
  isConnecting: boolean
  isReconnecting: boolean
  isSynchronizing: boolean
  isDegraded: boolean
  isDisconnected: boolean
}

interface LiveSyncRegistry {
  syncIds: Set<string>
  register: (syncId: string) => void
  unregister: (syncId: string) => void
  has: (syncId: string) => boolean
}

const ConnectionContext = createContext<ConnectionContextType | undefined>(undefined)
const LiveSyncRegistryContext = createContext<LiveSyncRegistry | undefined>(undefined)

/**
 * Provides WebSocket connection status to the component tree.
 * Wrap your app with this provider to use useLiveSync and useConnectionStatus.
 *
 * @example
 * <ConnectionProvider>
 *   <App />
 * </ConnectionProvider>
 */
export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [roomStatuses, setRoomStatuses] = useState<Record<string, ConnectionStatus>>({})
  const roomRefCounts = useRef(new Map<string, number>())

  const registryRef = useRef<LiveSyncRegistry>({
    syncIds: new Set(),
    register: (syncId: string) => {
      roomRefCounts.current.set(syncId, (roomRefCounts.current.get(syncId) ?? 0) + 1)
      registryRef.current.syncIds.add(syncId)
    },
    unregister: (syncId: string) => {
      const nextCount = (roomRefCounts.current.get(syncId) ?? 1) - 1
      if (nextCount > 0) {
        roomRefCounts.current.set(syncId, nextCount)
        return
      }
      roomRefCounts.current.delete(syncId)
      registryRef.current.syncIds.delete(syncId)
      setRoomStatuses((current) => {
        const { [syncId]: _removed, ...remaining } = current
        return remaining
      })
    },
    has: (syncId: string): boolean => registryRef.current.syncIds.has(syncId),
  })

  const setStatus = useCallback((syncId: string, status: ConnectionStatus) => {
    setRoomStatuses((current) => current[syncId] === status ? current : { ...current, [syncId]: status })
  }, [])

  const status = useMemo<ConnectionStatus>(() => {
    const statuses = [...registryRef.current.syncIds].map((syncId) => roomStatuses[syncId] ?? 'connecting')
    if (statuses.length === 0) return 'connecting'
    if (statuses.some((roomStatus) => roomStatus === 'reconnecting')) return 'reconnecting'
    if (statuses.some((roomStatus) => roomStatus === 'disconnected')) return 'disconnected'
    if (statuses.some((roomStatus) => roomStatus === 'connecting')) return 'connecting'
    if (statuses.some((roomStatus) => roomStatus === 'synchronizing')) return 'synchronizing'
    if (statuses.some((roomStatus) => roomStatus === 'degraded')) return 'degraded'
    if (statuses.every((roomStatus) => roomStatus === 'connected')) return 'connected'
    return 'connecting'
  }, [roomStatuses])

  const isConnected = status === 'connected'
  const isConnecting = status === 'connecting' || status === 'synchronizing'
  const isReconnecting = status === 'reconnecting'
  const isSynchronizing = status === 'synchronizing'
  const isDegraded = status === 'degraded'
  const isDisconnected = status === 'disconnected' || status === 'reconnecting'

  return (
    <ConnectionContext.Provider value={{ status, setStatus, roomStatuses, isConnected, isConnecting, isReconnecting, isSynchronizing, isDegraded, isDisconnected }}>
      <LiveSyncRegistryContext.Provider value={registryRef.current}>
        {children}
      </LiveSyncRegistryContext.Provider>
    </ConnectionContext.Provider>
  )
}

/**
 * Accesses the current WebSocket connection status.
 * Must be used within a ConnectionProvider.
 *
 * @example
 * const { status, isConnected } = useConnectionStatus()
 */
export function useConnectionStatus() {
  const context = useContext(ConnectionContext)
  if (!context) {
    throw new Error('useConnectionStatus must be used within ConnectionProvider')
  }
  return context
}

export function useLiveSyncRegistry() {
  const context = useContext(LiveSyncRegistryContext)
  if (!context) {
    throw new Error('useLiveSyncRegistry must be used within ConnectionProvider')
  }
  return context
}

export function useLiveSyncRegistrySafe() {
  return useContext(LiveSyncRegistryContext)
}
