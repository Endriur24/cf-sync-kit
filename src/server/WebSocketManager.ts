import type { Connection } from 'partyserver'

/**
 * Information about a connected WebSocket client.
 */
export type ConnectionInfo = {
  id: string
  connectedAt: number
}

/**
 * Tracks WebSocket connections and their metadata.
 * Provides connection inspection utilities.
 */
export class WebSocketManager {
  private connections = new Map<string, ConnectionInfo>()

  /**
   * Registers a new connection.
   */
  onConnect(connection: Connection) {
    const info: ConnectionInfo = {
      id: connection.id,
      connectedAt: Date.now(),
    }
    this.connections.set(connection.id, info)
    return info
  }

  /**
   * Removes a connection by id.
   */
  onDisconnect(connectionId: string) {
    this.connections.delete(connectionId)
  }

  /**
   * Returns the number of currently connected clients.
   */
  getConnectionCount(): number {
    return this.connections.size
  }

  /**
   * Returns a snapshot of all current connections.
   */
  getConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values())
  }

}
