import { Server } from 'partyserver'
import type { Connection, ConnectionContext } from 'partyserver'
import type { ActionType, CollectionName } from '../shared/types'
import type { WsBroadcastEvent } from '../shared/events'
import type { Repository } from './Repository'
import { BroadcastSystem } from './BroadcastSystem'
import { MiddlewareSystem, type MiddlewareContext } from './MiddlewareSystem'
import { MutationQueue } from './MutationQueue'
import { log } from '../shared/logger'
import { HTTPException } from 'hono/http-exception'

export interface DurableObjectConnectionContext {
  request: Request
  syncId: string
  userId?: string
  env: Bindings
}

export type DurableObjectConnectionAuthorizer = (context: DurableObjectConnectionContext) => void | Promise<void>

export interface MutationReceiptOptions {
  /** How long a mutation can be replayed idempotently. @default 86400000 (24 hours) */
  ttlMs?: number
  /** Maximum receipts retained per Durable Object room. @default 512 */
  maxEntries?: number
}

export interface DurableObjectBaseOptions {
  mutationReceipts?: MutationReceiptOptions
}

export interface MutationReceipt {
  fingerprint: string
  result: unknown
  createdAt?: number
  expiresAt?: number
  published?: boolean
  event?: WsBroadcastEvent
}

interface MutationReceiptIndexEntry {
  key: string
  createdAt: number
  expiresAt: number
}

const RECEIPT_INDEX_KEY = '__mutation_receipt_index'
const DEFAULT_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_RECEIPTS = 512

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
  private connectionAuthorizer?: DurableObjectConnectionAuthorizer
  private readonly receiptTtlMs: number
  private readonly maxReceipts: number

  constructor(ctx: DurableObjectState, env: Bindings, options?: DurableObjectBaseOptions) {
    super(ctx, env)
    this.storage = ctx.storage
    this.receiptTtlMs = options?.mutationReceipts?.ttlMs ?? DEFAULT_RECEIPT_TTL_MS
    this.maxReceipts = options?.mutationReceipts?.maxEntries ?? DEFAULT_MAX_RECEIPTS
    if (!Number.isFinite(this.receiptTtlMs) || this.receiptTtlMs <= 0) {
      throw new Error('mutationReceipts.ttlMs must be a positive finite number')
    }
    if (!Number.isInteger(this.maxReceipts) || this.maxReceipts <= 0) {
      throw new Error('mutationReceipts.maxEntries must be a positive integer')
    }
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

  protected authorizeConnections(authorizer: DurableObjectConnectionAuthorizer) {
    this.connectionAuthorizer = authorizer
    return this
  }

  /** Test/extension hook executed after sequence reservation and before the D1 write. */
  protected async beforeRepositoryMutation(_context: MiddlewareContext): Promise<void> {}

  /** Test/extension hook for publishing a mutation event. */
  protected publishMutationEvent(event: WsBroadcastEvent): void {
    this.broadcast(JSON.stringify(event))
  }

  /** Persists a receipt and prunes expired/old entries without consuming the room alarm. */
  protected async persistMutationReceipt(key: string, receipt: MutationReceipt): Promise<void> {
    await this.storage.transaction(async transaction => {
      let index = await transaction.get<MutationReceiptIndexEntry[]>(RECEIPT_INDEX_KEY)
      if (!index) {
        const existing = await transaction.list<MutationReceipt>({ prefix: 'mutation_' })
        index = [...existing.entries()].map(([existingKey, value]) => ({
          key: existingKey,
          createdAt: value.createdAt ?? 0,
          expiresAt: value.expiresAt ?? Number.MAX_SAFE_INTEGER,
        }))
      }

      const now = Date.now()
      const nextEntry: MutationReceiptIndexEntry = {
        key,
        createdAt: receipt.createdAt ?? now,
        expiresAt: receipt.expiresAt ?? now + this.receiptTtlMs,
      }
      const retained = index
        .filter(entry => entry.key !== key && entry.expiresAt > now)
        .concat(nextEntry)
        .sort((a, b) => a.createdAt - b.createdAt)
      const removed = retained.splice(0, Math.max(0, retained.length - this.maxReceipts))
      const retainedKeys = new Set(retained.map(entry => entry.key))
      const keysToDelete = index
        .filter(entry => !retainedKeys.has(entry.key) && entry.key !== key)
        .map(entry => entry.key)
        .concat(removed.map(entry => entry.key))

      await transaction.put(key, receipt)
      await transaction.put(RECEIPT_INDEX_KEY, retained)
      if (keysToDelete.length > 0) await transaction.delete([...new Set(keysToDelete)])
    })
  }

  private async getMutationReceipt(key: string): Promise<MutationReceipt | undefined> {
    const receipt = await this.storage.get<MutationReceipt>(key)
    if (!receipt) return undefined
    if (receipt.expiresAt !== undefined && receipt.expiresAt <= Date.now()) {
      await this.storage.delete(key)
      return undefined
    }
    return receipt
  }

  /**
   * Called when a client connects via WebSocket.
   * Sends sync-init event with current broadcast counters.
   */
  async onConnect(connection: Connection, context: ConnectionContext) {
    const userId = context.request.headers.get('x-cf-sync-user-id') ?? undefined
    await this.connectionAuthorizer?.({ request: context.request, syncId: this.name, userId, env: this.env })
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
      const receipt = await this.getMutationReceipt(receiptKey)
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) {
          throw new HTTPException(409, { message: 'Mutation ID was already used with a different request' })
        }
        if (receipt.published === false && receipt.event) {
          try {
            this.publishMutationEvent(receipt.event)
            await this.persistMutationReceipt(receiptKey, { ...receipt, published: true })
          } catch (error) {
            log.error('Committed mutation could not be republished:', error)
            throw new HTTPException(503, { message: 'Mutation committed; retry with the same mutation ID to recover' })
          }
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
        await this.beforeRepositoryMutation(middlewareCtx)

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

    const event: WsBroadcastEvent = {
      type: 'broadcast',
      collection,
      action,
      payload: result,
      broadcastId: broadcastId!,
      clientMutationId,
      scope,
    }
    const now = Date.now()
    const receipt: MutationReceipt | undefined = receiptKey ? {
      fingerprint,
      result,
      createdAt: now,
      expiresAt: now + this.receiptTtlMs,
      published: false,
      event,
    } : undefined

    if (receiptKey && receipt) {
      try {
        await this.persistMutationReceipt(receiptKey, receipt)
      } catch (error) {
        log.error('Mutation was committed but its receipt could not be stored:', error)
        throw new HTTPException(503, { message: 'Mutation committed; retry with the same mutation ID to recover' })
      }
    }

    try {
      this.publishMutationEvent(event)
      if (receiptKey && receipt) {
        await this.persistMutationReceipt(receiptKey, { ...receipt, published: true })
      }
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
