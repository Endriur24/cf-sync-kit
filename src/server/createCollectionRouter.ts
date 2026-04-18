import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import { isDev } from '../shared/logger'
import { DEFAULT_SYNC_ID } from '../shared/types'

/**
 * Helper to omit syncIdColumn from a Zod schema.
 * Useful when you want to use createInsertSchema directly without manual .omit().
 *
 * @example
 * const insertSchema = omitSyncIdColumn(createInsertSchema(todosTable), 'project_id')
 */
export function omitSyncIdColumn<T extends z.ZodType>(
  schema: T,
  syncIdColumn: string
): T {
  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape
    if (syncIdColumn in shape) {
      const omitFields: Record<string, true> = { [syncIdColumn]: true }
      return schema.omit(omitFields) as unknown as T
    }
  }
  return schema
}

const syncMetaSchema = z.object({
  syncId: z.string().min(1).optional(),
  _clientMutationId: z.string().optional(),
  scope: z.string().optional(),
})

const bulkInsertSchema = (itemSchema: z.ZodType) =>
  syncMetaSchema.extend({ items: z.array(itemSchema).min(1).max(100) })

const bulkUpdateSchema = (itemSchema: z.ZodType) =>
  syncMetaSchema.extend({ items: z.array(z.object({ id: z.string(), data: itemSchema })).min(1).max(100) })

const bulkDeleteSchema = syncMetaSchema.extend({ ids: z.array(z.string()).min(1).max(100) })

/**
 * Interface for a Durable Object room that can accept mutations.
 */
export interface RoomMutator {
  mutate(collection: string, action: string, syncId: string, payload: unknown, clientMutationId?: string, scope?: string, userId?: string): Promise<unknown>
  findAll?(collection: string, syncId: string): Promise<unknown[]>
}

/**
 * Function that resolves a Durable Object room for a given sync scope.
 */
export type GetRoomFn = (env: Bindings, syncId: string) => RoomMutator

/**
 * Configuration options for createCollectionRouter.
 */
export interface CollectionRouterOptions {
  /**
   * When true, GET requests are routed through the Durable Object
   * instead of reading directly from D1. This ensures consistency
   * with broadcast counters after hibernation.
   * @default false
   */
  consistentReads?: boolean
  /**
   * Extracts the authenticated user ID from the Hono context.
   * If provided, the userId is passed to the Durable Object middleware.
   */
  getUserId?: (c: any) => string | undefined
  /**
   * Validates that the authenticated user has access to the given syncId.
   * Called with (userId, syncId). Throw to deny access.
   * If not provided, no syncId access validation is performed.
   */
  validateSyncAccess?: (userId: string, syncId: string) => void | Promise<void>
  /**
   * Name of the Drizzle table column used as sync/tenant ID (default: "syncId")
   */
  syncIdColumn?: string
  /**
   * When true, syncId is optional in requests. Uses '_default' as the internal syncId.
   * Suitable for single-tenant applications where all data is shared.
   * @default false
   */
  singleTenant?: boolean
}

/**
 * Creates a Hono router with CRUD endpoints for a collection.
 * Routes: GET /:syncId?, POST /, PUT /:id, DELETE /:id, POST /bulk, PUT /bulk, DELETE /bulk
 *
 * @param collection - Collection name
 * @param table - Drizzle table definition
 * @param insertSchema - Zod schema for insert validation
 * @param updateSchema - Zod schema for update validation
 * @param getRoom - Function to resolve the Durable Object room
 * @param options - Optional router configuration
 * @returns Hono router with collection endpoints
 */
export function createCollectionRouter(
  collection: string,
  table: SQLiteTable,
  insertSchema: z.ZodType,
  updateSchema: z.ZodType,
  getRoom: GetRoomFn,
  options?: CollectionRouterOptions
) {
  const consistentReads = options?.consistentReads ?? false
  const getUserId = options?.getUserId
  const validateSyncAccess = options?.validateSyncAccess
  const syncIdColumn = options?.syncIdColumn ?? 'syncId'
  const singleTenant = options?.singleTenant ?? false

  const resolveSyncId = (syncId: string | undefined) => singleTenant ? (syncId ?? DEFAULT_SYNC_ID) : syncId!

  if (isDev && insertSchema instanceof z.ZodObject) {
    const shape = (insertSchema as z.ZodObject<z.ZodRawShape>).shape
    if (syncIdColumn in shape) {
      console.warn(
        `[cf-sync-kit] Warning: insertSchema for "${collection}" includes the syncIdColumn "${syncIdColumn}". ` +
        `This field will be stripped from the payload. ` +
        `Consider using .omit({ ${syncIdColumn}: true }) or omitSyncIdColumn() helper.`
      )
    }
  }

  const ensureAccess = async (c: any, syncId: string) => {
    const userId = getUserId
      ? getUserId(c)
      : (c.get('userId') as string | undefined)
        ?? (c.get('username') as string | undefined)

    if (validateSyncAccess) {
      if (!userId) {
        throw new HTTPException(401, {
          message: 'Unauthorized: userId is required when validateSyncAccess is configured. ' +
            'Provide getUserId in CollectionRouterOptions or set userId/username in Hono context.'
        })
      }
      await validateSyncAccess(userId, syncId)
    }
    return userId
  }

  const extractMeta = (body: Record<string, unknown>) => {
    const { syncId, _clientMutationId, scope, ...data } = body
    return {
      syncId: resolveSyncId(syncId as string | undefined),
      _clientMutationId: _clientMutationId as string | undefined,
      scope: scope as string | undefined,
      data,
    }
  }

  const route = new Hono<{ Bindings: Bindings }>({ strict: false })

  route.get('/:syncId?', async (c) => {
    const syncId = resolveSyncId(c.req.param('syncId'))
    const consistent = c.req.query('consistent') === 'true'
    await ensureAccess(c, syncId)

    if (consistent || consistentReads) {
      const room = getRoom(c.env, syncId)
      if (room.findAll) {
        return c.json({ [collection]: await room.findAll(collection, syncId) })
      }
      console.debug(
        `[cf-sync-kit] consistentReads requested but findAll not available for "${collection}". Falling back to direct D1 read.`
      )
    }

    try {
      const db = drizzle(c.env.DB)
      if (singleTenant) {
        const results = await db.select().from(table)
        return c.json({ [collection]: results })
      }
      const results = await db.select().from(table).where(eq((table as any)[syncIdColumn], syncId))
      return c.json({ [collection]: results })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[cf-sync-kit] D1 error in GET /${collection}:`, message)
      throw new HTTPException(500, { message: `Failed to fetch ${collection}: ${message}` })
    }
  })

  route.post('/', zValidator('json', insertSchema.and(syncMetaSchema)), async (c) => {
    const body = c.req.valid('json')
    const { syncId, _clientMutationId, scope, data } = extractMeta(body)
    const userId = await ensureAccess(c, syncId)
    const room = getRoom(c.env, syncId)
    // Inject ownerId on the backend — never trust client-provided owner fields
    // scope is always preserved for broadcast filtering
    const payload = singleTenant
      ? scope ? { ...data, scope } : { ...data }
      : scope ? { ...data, scope, ownerId: userId } : { ...data, ownerId: userId }
    const result = await room.mutate(collection, 'insert', syncId, payload, _clientMutationId, scope, userId)
    return c.json({ success: true, data: result })
  })

  route.put('/bulk', zValidator('json', bulkUpdateSchema(updateSchema)), async (c) => {
    const body = c.req.valid('json')
    const { syncId: rawSyncId, _clientMutationId, scope, items } = body
    const syncId = resolveSyncId(rawSyncId)
    const userId = await ensureAccess(c, syncId)
    const room = getRoom(c.env, syncId)

    console.debug(`[cf-sync-kit] bulk-update "${collection}" for syncId="${syncId}": ${items.length} items`)

    const payload = items.map(({ id, data }) => {
      // Strip ownerId from update payload — never trust client-provided owner fields
      const { ownerId: _stripped, ...cleanData } = data as Record<string, unknown>
      return {
        id,
        data: scope ? { ...cleanData, scope } : cleanData,
      }
    })

    const result = await room.mutate(collection, 'bulk-update', syncId, payload, _clientMutationId, scope, userId)
    return c.json({ success: true, data: result })
  })

  route.put('/:id', zValidator('json', updateSchema.and(syncMetaSchema)), async (c) => {
    const { id } = c.req.param()
    const body = c.req.valid('json')
    const { syncId, _clientMutationId, scope, data } = extractMeta(body)
    const userId = await ensureAccess(c, syncId)
    const room = getRoom(c.env, syncId)
    // Strip ownerId from update payload — never trust client-provided owner fields
    const { ownerId: _stripped, ...cleanData } = data as Record<string, unknown>
    const payload = scope ? { ...cleanData, scope } : cleanData
    const result = await room.mutate(collection, 'update', syncId, { id, data: payload }, _clientMutationId, scope, userId)
    return c.json({ success: true, data: result })
  })

  route.delete('/bulk', zValidator('json', bulkDeleteSchema), async (c) => {
    const { syncId: rawSyncId, _clientMutationId, scope, ids } = c.req.valid('json')
    const syncId = resolveSyncId(rawSyncId)
    const userId = await ensureAccess(c, syncId)
    const room = getRoom(c.env, syncId)

    console.debug(`[cf-sync-kit] bulk-delete "${collection}" for syncId="${syncId}": ${ids.length} items`)

    await room.mutate(collection, 'bulk-delete', syncId, ids, _clientMutationId, scope, userId)
    return c.json({ success: true })
  })

  route.post('/bulk', zValidator('json', bulkInsertSchema(insertSchema)), async (c) => {
    const body = c.req.valid('json')
    const { syncId: rawSyncId, _clientMutationId, scope, items } = body
    const syncId = resolveSyncId(rawSyncId)
    const userId = await ensureAccess(c, syncId)
    const room = getRoom(c.env, syncId)

    console.debug(`[cf-sync-kit] bulk-insert "${collection}" for syncId="${syncId}": ${items.length} items`)

    const payload = items.map(item => ({
      ...(item as object),
      ...(scope && { scope }),
      ...(!singleTenant && { ownerId: userId })
    }))

    const result = await room.mutate(collection, 'bulk-insert', syncId, payload, _clientMutationId, scope, userId)
    return c.json({ success: true, data: result })
  })

  // Use query params for DELETE — some reverse proxies (nginx, AWS ALB) strip body from DELETE requests
  route.delete('/:id', zValidator('query', syncMetaSchema), async (c) => {
    const { id } = c.req.param()
    const { syncId: rawSyncId, _clientMutationId, scope } = c.req.valid('query')

    // In multi-tenant mode, syncId is required for tenant isolation
    if (!singleTenant && !rawSyncId) {
      throw new HTTPException(400, {
        message: 'syncId query parameter is required for multi-tenant mode',
      })
    }

    const syncId = resolveSyncId(rawSyncId)
    const userId = await ensureAccess(c, syncId)
    const room = getRoom(c.env, syncId)
    await room.mutate(collection, 'delete', syncId, { id }, _clientMutationId, scope, userId)
    return c.json({ success: true })
  })

  return route
}
