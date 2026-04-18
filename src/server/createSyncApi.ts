import { Hono } from 'hono'
import type { CollectionsMap } from '../shared/types'
import type { GetRoomFn, CollectionRouterOptions } from './createCollectionRouter'
import { createCollectionRouter } from './createCollectionRouter'

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
 * Each collection gets mounted at `/:collectionName` with CRUD endpoints.
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
    const status = (err as any).status || 500
    const message = (err as any).message || 'Internal Server Error'
    console.error('[cf-sync-kit] Unhandled Server Error:', err)
    return c.json({ error: { message } }, status)
  })

  Object.entries(collections).forEach(([collectionName, config]) => {
    const router = createCollectionRouter(
      collectionName,
      config.table,
      config.insertSchema,
      config.updateSchema,
      getRoom,
      { ...options, syncIdColumn: config.syncIdColumn ?? options?.syncIdColumn ?? 'syncId', singleTenant: (config as any).singleTenant ?? options?.singleTenant ?? false }
    )

    app.route(`/${collectionName}`, router)
  })

  return app
}
