import { Server } from 'partyserver'
import type { Connection } from 'partyserver'
import type { ActionType, CollectionName } from '../shared/types'
import type { WsBroadcastEvent } from '../shared/events'
import type { Repository } from './Repository'
import { BroadcastSystem } from './BroadcastSystem'
import { WebSocketManager, type ConnectionInfo } from './WebSocketManager'
import { MiddlewareSystem, type MiddlewareContext } from './MiddlewareSystem'
import { log } from '../shared/logger'
import { HTTPException } from 'hono/http-exception'

/**
 * Base class for Durable Objects that handle real-time collection synchronization.
 *
 * Extend this class to create your application's Durable Object.
 * Register repositories in the constructor and optionally add middleware.
 *
 * @example
 * export class ProjectRoom extends DurableObjectBase {
 *   constructor(ctx: DurableObjectState, env: Bindings) {
 *     super(ctx, env)
 *     this.registerRepository(new Repository(env.DB, todosTable, 'todos'))
 *   }
 * }
 */
export abstract class DurableObjectBase extends Server<Bindings> {
  static options = { hibernate: true }

  protected repositories = new Map<string, Repository<any>>()
  protected broadcastSystem: BroadcastSystem
  protected wsManager: WebSocketManager
  protected middlewareSystem: MiddlewareSystem

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env)
    this.broadcastSystem = new BroadcastSystem(ctx.storage)
    this.wsManager = new WebSocketManager()
    this.middlewareSystem = new MiddlewareSystem()
  }

  /**
   * Returns the number of currently connected WebSocket clients.
   * Useful for monitoring and health checks.
   */
  get connectionCount(): number {
    return this.wsManager.getConnectionCount()
  }

  /**
   * Returns a snapshot of all current WebSocket connections with metadata.
   * Useful for monitoring and debugging.
   */
  get connectedClients(): ConnectionInfo[] {
    return this.wsManager.getConnections()
  }

  /**
   * Registers a repository for a collection.
   * @param repo - Repository instance bound to a Drizzle table
   */
  protected registerRepository(repo: Repository<any>) {
    this.repositories.set(repo.collectionName, repo)
  }

  /**
   * Adds middleware to the mutation pipeline.
   * Middleware runs before each mutation and can modify or reject requests.
   *
   * @example
   * this.use(async (ctx, next) => {
   *   if (!ctx.userId) throw new Error('Unauthorized')
   *   await next()
   * })
   */
  use(middleware: (ctx: MiddlewareContext, next: () => Promise<void>) => Promise<void>) {
    this.middlewareSystem.use(middleware)
    return this
  }

  /**
   * Called when a client connects via WebSocket.
   * Sends sync-init event with current broadcast counters.
   */
  async onConnect(connection: Connection) {
    log.debug('Client connected:', connection.id)
    this.wsManager.onConnect(connection)

    try {
      const counters = await this.broadcastSystem.getAllCounters()
      connection.send(JSON.stringify({
        type: 'sync-init',
        counters,
      }))
    } catch (error) {
      log.error('Failed to initialize sync for client:', connection.id, error)
      connection.send(JSON.stringify({
        type: 'error',
        message: 'Failed to initialize sync. Please reconnect.',
      }))
    }
  }

  /**
   * Called when a client disconnects.
   */
  onDisconnect(connection: Connection) {
    this.wsManager.onDisconnect(connection.id)
  }

  /**
   * Executes a mutation on a collection.
   * Runs middleware, performs the database operation, then broadcasts the result.
   *
   * @param collection - Collection name
   * @param action - Mutation action type
   * @param syncId - Sync ID for multi-tenant isolation
   * @param payload - Mutation payload (varies by action)
   * @param clientMutationId - Optional ID for optimistic update correlation
   * @param scope - Optional scope for filtering broadcasts
   * @returns The result of the mutation
   */
  async mutate(
    collection: CollectionName,
    action: ActionType,
    syncId: string,
    payload: unknown,
    clientMutationId?: string,
    scope?: string,
    userId?: string
  ) {
    const repo = this.repositories.get(collection)
    if (!repo) throw new HTTPException(400, { message: `Collection ${collection} not registered` })

    const middlewareCtx: MiddlewareContext = {
      collection,
      action,
      syncId,
      payload,
      userId,
      env: this.env,
    }

    await this.middlewareSystem.execute(middlewareCtx)

    let result: unknown
    try {
      switch (action) {
        case 'insert':
          result = await repo.create(syncId, payload as Record<string, unknown>)
          break
        case 'update': {
          const data = payload as { id: string; data: Record<string, unknown> }
          result = await repo.update(syncId, data.id, data.data)
          break
        }
        case 'delete': {
          const data = payload as { id: string }
          await repo.delete(syncId, data.id)
          result = { id: data.id }
          break
        }
        case 'bulk-insert':
          result = await repo.bulkCreate(syncId, payload as Record<string, unknown>[])
          break
        case 'bulk-update':
          result = await repo.bulkUpdate(syncId, payload as { id: string; data: Record<string, unknown> }[])
          break
        case 'bulk-delete':
          await repo.bulkDelete(syncId, payload as string[])
          result = { ids: payload }
          break
        default:
          throw new HTTPException(400, { message: `Unknown action: ${action}` })
      }
    } catch (error) {
      if (error instanceof HTTPException) throw error
      log.error(`Mutation failed: ${collection}/${action}`, error)
      throw new HTTPException(500, { message: error instanceof Error ? error.message : 'Mutation failed' })
    }

    if (result) {
      try {
        const broadcastId = await this.broadcastSystem.getNextId(collection)

        const event: WsBroadcastEvent = {
          type: 'broadcast',
          collection,
          action,
          payload: result,
          broadcastId,
          clientMutationId,
          scope,
        }

        this.broadcast(JSON.stringify(event))
      } catch (error) {
        log.error('Failed to broadcast mutation result:', error)
      }
    }

    return result
  }

  /**
   * Finds all entities in a collection for a sync scope.
   */
  async findAll(collection: string, syncId: string) {
    const repo = this.repositories.get(collection)
    if (!repo) throw new HTTPException(400, { message: `Collection ${collection} not registered` })
    return repo.findAll(syncId)
  }

  /**
   * Broadcasts a sync event to all connected clients.
   * Useful for custom server-side operations that need to notify clients.
   */
  async broadcastSyncEvent(collection: CollectionName, action: ActionType, payload: unknown) {
    try {
      const broadcastId = await this.broadcastSystem.getNextId(collection)

      const event: WsBroadcastEvent = {
        type: 'broadcast',
        collection,
        action,
        payload,
        broadcastId,
      }

      this.broadcast(JSON.stringify(event))
    } catch (error) {
      log.error('Failed to broadcast sync event:', error)
      throw error
    }
  }
}
