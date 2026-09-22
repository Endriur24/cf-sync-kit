import { Server } from 'partyserver'
import type { Connection } from 'partyserver'
import type { ActionType, CollectionName } from '../shared/types'
import type { WsBroadcastEvent } from '../shared/events'
import type { Repository } from './Repository'
import { BroadcastSystem } from './BroadcastSystem'
import { MiddlewareSystem, type MiddlewareContext } from './MiddlewareSystem'
import { MutationQueue } from './MutationQueue'
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
  protected middlewareSystem: MiddlewareSystem
  private connections = new Set<string>()
  private mutationQueue = new MutationQueue()
  private readonly storage: DurableObjectStorage

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env)
    this.storage = ctx.storage
    // Respond to liveness probes at the edge, including while the object is hibernated.
    // This prevents heartbeat traffic from waking the Durable Object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    this.broadcastSystem = new BroadcastSystem(ctx.storage)
    this.middlewareSystem = new MiddlewareSystem()
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
    this.connections.add(connection.id)

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
    this.connections.delete(connection.id)
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
    return this.mutationQueue.enqueue(() => this.mutateInOrder(collection, action, syncId, payload, clientMutationId, scope, userId))
  }

  private async mutateInOrder(
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

    const receiptKey = clientMutationId
      ? `mutation_${collection}_${encodeURIComponent(clientMutationId)}`
      : undefined
    const fingerprint = JSON.stringify({ action, syncId, scope, payload })
    if (receiptKey) {
      const receipt = await this.storage.get<{ fingerprint: string; result: unknown }>(receiptKey)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          throw new HTTPException(409, { message: 'Mutation ID was already used with a different request' })
        }
        return receipt.result
      }
    }

    const middlewareCtx: MiddlewareContext = {
      collection,
      action,
      syncId,
      payload,
      userId,
      env: this.env,
    }

    let result: unknown
    let broadcastId: number | undefined
    let operationReached = false
    try {
      await this.middlewareSystem.execute(middlewareCtx, async () => {
        operationReached = true
        // Reserve the sequence before the D1 write. A failed write intentionally leaves
        // a gap, which makes connected clients refetch instead of silently going stale.
        broadcastId = await this.broadcastSystem.getNextId(collection)

        switch (action) {
          case 'insert':
            result = await repo.create(syncId, payload as Record<string, unknown>)
            break
          case 'update': {
            const data = payload as { id: string; data: Record<string, unknown> }
            result = await repo.update(syncId, data.id, data.data, scope)
            if (!result) throw new HTTPException(404, { message: 'Entity not found in this scope' })
            break
          }
          case 'delete': {
            const data = payload as { id: string }
            const deleted = await repo.delete(syncId, data.id, scope)
            if (!deleted) throw new HTTPException(404, { message: 'Entity not found in this scope' })
            result = { id: data.id }
            break
          }
          case 'bulk-insert':
            result = await repo.bulkCreate(syncId, payload as Record<string, unknown>[])
            break
          case 'bulk-update':
            result = await repo.bulkUpdate(syncId, payload as { id: string; data: Record<string, unknown> }[], scope)
            break
          case 'bulk-delete':
            await repo.bulkDelete(syncId, payload as string[], scope)
            result = { ids: payload }
            break
          default:
            throw new HTTPException(400, { message: `Unknown action: ${action}` })
        }
      })
    } catch (error) {
      // DO RPC strips the HTTPException prototype, so we encode the status in the message.
      const status = (error as any)?.status
      if (typeof status === 'number' && status >= 400 && status < 500) {
        const message = (error as any).message || 'Forbidden'
        throw new HTTPException(status as any, { message: `[STATUS:${status}] ${message}` })
      }
      log.error(`Mutation failed: ${collection}/${action}`, error)
      throw new HTTPException(500, { message: error instanceof Error ? error.message : 'Mutation failed' })
    }

    // Middleware may intentionally short-circuit by not calling next(). In that case
    // there was no database mutation to receipt or broadcast.
    if (!operationReached) return undefined

    if (receiptKey) {
      await this.storage.put(receiptKey, { fingerprint, result })
    }

    try {
      const event: WsBroadcastEvent = {
        type: 'broadcast',
        collection,
        action,
        payload: result,
        broadcastId: broadcastId!,
        clientMutationId,
        scope,
      }
      this.broadcast(JSON.stringify(event))
    } catch (error) {
      log.error('Mutation was committed but could not be broadcast:', error)
      throw new HTTPException(503, { message: 'Mutation committed; retry with the same mutation ID to recover' })
    }

    return result
  }

  /**
   * Finds all entities in a collection for a sync scope and optional sub-scope.
   */
  async findAll(collection: string, syncId: string, scope?: string) {
    const repo = this.repositories.get(collection)
    if (!repo) throw new HTTPException(400, { message: `Collection ${collection} not registered` })
    return repo.findAll(syncId, scope)
  }

  /**
   * Broadcasts a sync event to all connected clients.
   * Useful for custom server-side operations that need to notify clients.
   */
  async broadcastSyncEvent(
    collection: CollectionName,
    action: ActionType,
    payload: unknown,
    scope?: string,
  ) {
    try {
      const broadcastId = await this.broadcastSystem.getNextId(collection)

      const event: WsBroadcastEvent = {
        type: 'broadcast',
        collection,
        action,
        payload,
        broadcastId,
        scope,
      }

      this.broadcast(JSON.stringify(event))
    } catch (error) {
      log.error('Failed to broadcast sync event:', error)
      throw error
    }
  }
}
