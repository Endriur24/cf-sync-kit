import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { MiddlewareHandler } from 'hono'
import type { CollectionsMap } from '../shared/types'
import type { GetRoomFn, CollectionRouterOptions, CollectionHandlers } from './createCollectionRouter'
import { createCollectionHandlers } from './createCollectionRouter'

/**
 * Options for createSyncApi, extending CollectionRouterOptions with API-level settings.
 */
export interface SyncApiOptions extends CollectionRouterOptions {
  /**
   * When true, the /health endpoint includes collection names in the response.
   * Set to false in production to avoid leaking internal collection names.
   * @default true
   */
  exposeCollections?: boolean
}

/**
 * Creates a Hono app with sync API routes for all collections.
 *
 * All collection routes are mounted at `/:syncId/:collection` so that every
 * collection for a tenant lives under one prefix.
 *
 * Multi-tenant example:
 *   GET    /project-abc/todos
 *   POST   /project-abc/todos
 *   PUT    /project-abc/todos/:id
 *   DELETE /project-abc/todos/:id
 *   POST   /project-abc/todos/bulk
 *   PUT    /project-abc/todos/bulk
 *   DELETE /project-abc/todos/bulk
 *
 * Single-tenant example (uses syncId = 'default'):
 *   GET    /default/todos
 *   POST   /default/todos
 *   ...
 *
 * Includes a global error handler that guarantees all errors are returned
 * in the format { error: { message } } — matching what the client-side
 * apiFetch expects.
 *
 * @param collections - Collection configuration map
 * @param getRoom - Function to resolve the Durable Object room per sync scope
 * @param options - Optional router configuration (e.g. consistentReads, exposeCollections)
 * @returns Hono app with all collection routes
 *
 * @example
 * const syncApi = createSyncApi(collectionsConfig, createGetRoomFn(env.PROJECT_ROOM), { consistentReads: true })
 * app.route('/api', syncApi)
 */
export function createSyncApi(
  collections: CollectionsMap,
  getRoom: GetRoomFn,
  options?: SyncApiOptions
) {
  const exposeCollections = options?.exposeCollections ?? true
  const app = new Hono<{ Bindings: Bindings }>({ strict: false })

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      ...(exposeCollections && { collections: Object.keys(collections) }),
    })
  })

  app.onError((err, c) => {
    let status = (err as any).status || 500
    let message = (err as any).message || 'Internal Server Error'

    // DO RPC strips the HTTPException prototype; recover status encoded in the message.
    const match = message.match(/^\[STATUS:(\d{3})\]\s+(.*)$/)
    if (match) {
      status = parseInt(match[1], 10)
      message = match[2]
    }

    console.error('[cf-sync-kit] Unhandled Server Error:', err)
    return c.json({ error: { message } }, status)
  })

  // Build a handler map per collection. createSyncApi owns the global path
  // structure `/:syncId/:collection/...` and delegates to the collection's handlers.
  const handlerMap = new Map<string, CollectionHandlers>()

  Object.entries(collections).forEach(([collectionName, config]) => {
    const handlers = createCollectionHandlers(
      collectionName,
      config.table,
      config.insertSchema,
      config.updateSchema,
      getRoom,
      {
        ...options,
        syncIdColumn: config.syncIdColumn ?? options?.syncIdColumn ?? 'syncId',
        singleTenant: (config as any).singleTenant ?? options?.singleTenant ?? false,
        softDeleteColumn: (config as any).softDeleteColumn ?? (options as any)?.softDeleteColumn
      }
    )
    handlerMap.set(collectionName, handlers)
  })

  // Middleware that validates the collection name exists before delegating.
  const validateCollection: MiddlewareHandler = async (c, next) => {
    const collection = c.req.param('collection')
    if (!collection || !handlerMap.has(collection)) {
      throw new HTTPException(404, { message: `Collection '${collection}' not found` })
    }
    await next()
  }

  // Helper to retrieve the handler for the current collection.
  const getHandlers = (c: Parameters<CollectionHandlers['getAll']>[0]): CollectionHandlers => {
    return handlerMap.get(c.req.param('collection') as string)!
  }

  // Order matters: register bulk routes before `/:id` so that 'bulk' is not treated as an id.
  app.get('/:syncId/:collection', validateCollection, (c) => getHandlers(c).getAll(c))
  app.post('/:syncId/:collection', validateCollection, (c) => getHandlers(c).create(c))

  app.post('/:syncId/:collection/bulk', validateCollection, (c) => getHandlers(c).bulkCreate(c))
  app.put('/:syncId/:collection/bulk', validateCollection, (c) => getHandlers(c).bulkUpdate(c))
  app.delete('/:syncId/:collection/bulk', validateCollection, (c) => getHandlers(c).bulkDelete(c))

  app.put('/:syncId/:collection/:id', validateCollection, (c) => getHandlers(c).update(c))
  app.delete('/:syncId/:collection/:id', validateCollection, (c) => getHandlers(c).remove(c))

  return app
}
