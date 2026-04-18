import { createContext, useContext, useState, useRef, type ReactNode } from 'react'
import type { ConnectionStatus } from '../../shared/types'

interface ConnectionContextType {
  status: ConnectionStatus
  setStatus: (status: ConnectionStatus) => void
  isConnected: boolean
  isConnecting: boolean
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
  const [status, setStatus] = useState<ConnectionStatus>('connecting')

  const registryRef = useRef<LiveSyncRegistry>({
    syncIds: new Set(),
    register: (syncId: string) => { registryRef.current.syncIds.add(syncId) },
    unregister: (syncId: string) => { registryRef.current.syncIds.delete(syncId) },
    has: (syncId: string): boolean => registryRef.current.syncIds.has(syncId),
  })

  const isConnected = status === 'connected'
  const isConnecting = status === 'connecting'
  const isDisconnected = status === 'disconnected'

  return (
    <ConnectionContext.Provider value={{ status, setStatus, isConnected, isConnecting, isDisconnected }}>
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
