import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and, isNull } from 'drizzle-orm'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import type { Context } from 'hono'
import { isDev } from '../shared/logger'
import { DEFAULT_SYNC_ID } from '../shared/types'

const syncMetaSchema = z.object({
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
 * Configuration options for createCollectionHandlers / createSyncApi.
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
   * Name of the Drizzle table column used as sync/tenant ID (default: "syncId").
   * Ignored when singleTenant is true.
   */
  syncIdColumn?: string
  /**
   * When true, syncId is optional in requests. Uses DEFAULT_SYNC_ID as the internal syncId.
   * Suitable for single-tenant applications where all data is shared.
   * @default false
   */
  singleTenant?: boolean
  /**
   * Name of the D1 database binding to use (default: "DB").
   * Use this if your wrangler config uses a different binding name.
   */
  dbName?: string
  /**
   * Name of the column for soft-delete (e.g. "deletedAt") or `true` to use "deletedAt" as default.
   * When enabled, GET requests will filter out soft-deleted records.
   */
  softDeleteColumn?: string | boolean
}

/**
 * Handlers returned by createCollectionHandlers. Each handler expects
 * to be mounted at `/:syncId/:collection/...` by createSyncApi.
 */
export interface CollectionHandlers {
  getAll: (c: Context) => Promise<Response>
  create: (c: Context) => Promise<Response>
  update: (c: Context) => Promise<Response>
  remove: (c: Context) => Promise<Response>
  bulkCreate: (c: Context) => Promise<Response>
  bulkUpdate: (c: Context) => Promise<Response>
  bulkDelete: (c: Context) => Promise<Response>
}

  // zValidator is invoked manually inside handlers, so TypeScript cannot infer
  // validated data on the context. Use a small helper to read it back.
  const getValidated = (c: Context, target: 'json' | 'query'): any => (c.req.valid as any)(target)

/**
 * Creates handlers for a single collection. The handlers are not a Hono router;
 * createSyncApi mounts them at `/:syncId/:collection/...`.
 *
 * @param collection - Collection name
 * @param table - Drizzle table definition
 * @param insertSchema - Zod schema for insert validation
 * @param updateSchema - Zod schema for update validation
 * @param getRoom - Function to resolve the Durable Object room
 * @param options - Optional router configuration
 * @returns Object with handler functions for createSyncApi
 */
export function createCollectionHandlers(
  collection: string,
  table: AnySQLiteTable,
  insertSchema: z.ZodType,
  updateSchema: z.ZodType,
  getRoom: GetRoomFn,
  options?: CollectionRouterOptions
): CollectionHandlers {
  const consistentReads = options?.consistentReads ?? false
  const getUserId = options?.getUserId
  const validateSyncAccess = options?.validateSyncAccess
  const syncIdColumn = options?.syncIdColumn ?? 'syncId'
  const singleTenant = options?.singleTenant ?? false
  const dbName = options?.dbName ?? 'DB'
  const softDeleteCol = options?.softDeleteColumn === true ? 'deletedAt' : (typeof options?.softDeleteColumn === 'string' ? options.softDeleteColumn : null)

  const resolveSyncId = (syncId: string | undefined) => singleTenant ? (syncId ?? DEFAULT_SYNC_ID) : syncId!

  if (isDev && insertSchema instanceof z.ZodObject) {
    const shape = (insertSchema as z.ZodObject<z.ZodRawShape>).shape
    if (syncIdColumn in shape) {
      console.warn(
        `[cf-sync-kit] Warning: insertSchema for "${collection}" includes the syncIdColumn "${syncIdColumn}". ` +
        `This field will be stripped from the payload. ` +
        `Consider using .omit({ ${syncIdColumn}: true }).`
      )
    }
  }

  const ensureAccess = async (c: Context, syncId: string) => {
    const userId = getUserId
      ? getUserId(c)
      : (c.get('userId' as never) as string | undefined)
        ?? (c.get('username' as never) as string | undefined)

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
    const { _clientMutationId, scope, ...data } = body
    return {
      _clientMutationId: _clientMutationId as string | undefined,
      scope: scope as string | undefined,
      data,
    }
  }

  const getSyncIdFromParam = (c: Context) => {
    const syncId = c.req.param('syncId')
    return resolveSyncId(syncId)
  }

  return {
    getAll: async (c: Context) => {
      const syncId = getSyncIdFromParam(c)
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
        const db = drizzle(c.env[dbName as keyof typeof c.env] as D1Database)
        const conditions = []

        if (!singleTenant) conditions.push(eq((table as any)[syncIdColumn], syncId))
        if (softDeleteCol) conditions.push(isNull((table as any)[softDeleteCol]))

        let query = db.select().from(table)
        if (conditions.length === 1) {
          query = query.where(conditions[0]) as any
        } else if (conditions.length > 1) {
          query = query.where(and(...conditions)) as any
        }

        const results = await query
        return c.json({ [collection]: results })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[cf-sync-kit] D1 error in GET /${collection}:`, message)
        throw new HTTPException(500, { message: `Failed to fetch ${collection}: ${message}` })
      }
    },

    create: async (c: Context) => {
      await zValidator('json', insertSchema.and(syncMetaSchema))(c, async () => {})
      const body = getValidated(c, 'json')
      const syncId = getSyncIdFromParam(c)
      const { _clientMutationId, scope, data } = extractMeta(body)
      const userId = await ensureAccess(c, syncId)
      const room = getRoom(c.env, syncId)
      // Inject ownerId on the backend — never trust client-provided owner fields
      // scope is always preserved for broadcast filtering
      const payload = singleTenant
        ? scope ? { ...data, scope } : { ...data }
        : scope ? { ...data, scope, ownerId: userId } : { ...data, ownerId: userId }
      const result = await room.mutate(collection, 'insert', syncId, payload, _clientMutationId, scope, userId)
      return c.json({ success: true, data: result })
    },

    update: async (c: Context) => {
      await zValidator('json', updateSchema.and(syncMetaSchema))(c, async () => {})
      const { id } = c.req.param()
      const body = getValidated(c, 'json')
      const syncId = getSyncIdFromParam(c)
      const { _clientMutationId, scope, data } = extractMeta(body)
      const userId = await ensureAccess(c, syncId)
      const room = getRoom(c.env, syncId)
      // Strip ownerId from update payload — never trust client-provided owner fields
      const { ownerId: _stripped, ...cleanData } = data as Record<string, unknown>
      const payload = scope ? { ...cleanData, scope } : cleanData
      const result = await room.mutate(collection, 'update', syncId, { id, data: payload }, _clientMutationId, scope, userId)
      return c.json({ success: true, data: result })
    },

    remove: async (c: Context) => {
      await zValidator('query', syncMetaSchema)(c, async () => {})
      const { id } = c.req.param()
      const { _clientMutationId, scope } = getValidated(c, 'query')
      const syncId = getSyncIdFromParam(c)
      const userId = await ensureAccess(c, syncId)
      const room = getRoom(c.env, syncId)
      await room.mutate(collection, 'delete', syncId, { id }, _clientMutationId, scope, userId)
      return c.json({ success: true })
    },

    bulkCreate: async (c: Context) => {
      await zValidator('json', bulkInsertSchema(insertSchema))(c, async () => {})
      const body = getValidated(c, 'json')
      const syncId = getSyncIdFromParam(c)
      const { _clientMutationId, scope, items } = body
      const userId = await ensureAccess(c, syncId)
      const room = getRoom(c.env, syncId)

      console.debug(`[cf-sync-kit] bulk-insert "${collection}" for syncId="${syncId}": ${items.length} items`)

      const payload = (items as Record<string, unknown>[]).map(item => {
        const { ownerId: _stripped, ...cleanItem } = item
        return {
          ...cleanItem,
          ...(scope && { scope }),
          ...(!singleTenant && { ownerId: userId })
        }
      })

      const result = await room.mutate(collection, 'bulk-insert', syncId, payload, _clientMutationId, scope, userId)
      return c.json({ success: true, data: result })
    },

    bulkUpdate: async (c: Context) => {
      await zValidator('json', bulkUpdateSchema(updateSchema))(c, async () => {})
      const body = getValidated(c, 'json')
      const syncId = getSyncIdFromParam(c)
      const { _clientMutationId, scope, items } = body
      const userId = await ensureAccess(c, syncId)
      const room = getRoom(c.env, syncId)

      console.debug(`[cf-sync-kit] bulk-update "${collection}" for syncId="${syncId}": ${items.length} items`)

      const payload = (items as { id: string; data: Record<string, unknown> }[]).map(({ id, data }) => {
        // Strip ownerId from update payload — never trust client-provided owner fields
        const { ownerId: _stripped, ...cleanData } = data
        return {
          id,
          data: scope ? { ...cleanData, scope } : cleanData,
        }
      })

      const result = await room.mutate(collection, 'bulk-update', syncId, payload, _clientMutationId, scope, userId)
      return c.json({ success: true, data: result })
    },

    bulkDelete: async (c: Context) => {
      await zValidator('json', bulkDeleteSchema)(c, async () => {})
      const body = getValidated(c, 'json')
      const syncId = getSyncIdFromParam(c)
      const { _clientMutationId, scope, ids } = body
      const userId = await ensureAccess(c, syncId)
      const room = getRoom(c.env, syncId)

      console.debug(`[cf-sync-kit] bulk-delete "${collection}" for syncId="${syncId}": ${ids.length} items`)

      await room.mutate(collection, 'bulk-delete', syncId, ids, _clientMutationId, scope, userId)
      return c.json({ success: true })
    },
  }
}
