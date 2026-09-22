import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and, isNull, asc, desc } from 'drizzle-orm'
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
  findAll?(collection: string, syncId: string, scope?: string): Promise<unknown[]>
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
   * Name of the Drizzle table column used for scope filtering (default: "scope").
   */
  scopeColumn?: string
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
  /**
   * Name of the column to order GET results by (default: "createdAt" if present, else "id").
   */
  orderByColumn?: string
  /**
   * Order direction for GET results (default: "desc" - newest first).
   */
  orderDirection?: 'asc' | 'desc'
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

async function parseJson(c: Context, schema: z.ZodType): Promise<any> {
  const body = await c.req.json().catch(() => undefined)
  const result = await schema.safeParseAsync(body)
  if (!result.success) throw new HTTPException(400, { message: 'Validation failed' })
  return result.data
}

async function parseQuery(c: Context, schema: z.ZodType): Promise<any> {
  const result = await schema.safeParseAsync(c.req.query())
  if (!result.success) throw new HTTPException(400, { message: 'Validation failed' })
  return result.data
}

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
  const scopeColumn = options?.scopeColumn ?? 'scope'
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

  const assertNoProtectedFields = (data: Record<string, unknown>) => {
    const protectedFields = ['id', 'ownerId', syncIdColumn, scopeColumn]
    const field = protectedFields.find((name) => name in data)
    if (field) throw new HTTPException(400, { message: `Field "${field}" cannot be set by the client` })
  }

  const getSyncIdFromParam = (c: Context) => {
    const syncId = c.req.param('syncId')
    return resolveSyncId(syncId)
  }

  return {
    getAll: async (c: Context) => {
      const syncId = getSyncIdFromParam(c)
      const consistent = c.req.query('consistent') === 'true'
      const scope = c.req.query('scope')
      await ensureAccess(c, syncId)

      if (consistent || consistentReads) {
        const room = getRoom(c.env, syncId)
        if (room.findAll) {
          const results = scope !== undefined
            ? await room.findAll(collection, syncId, scope)
            : await room.findAll(collection, syncId)
          return c.json({ [collection]: results })
        }
        console.debug(
          `[cf-sync-kit] consistentReads requested but findAll not available for "${collection}". Falling back to direct D1 read.`
        )
      }

      try {
        const db = drizzle(c.env[dbName as keyof typeof c.env] as D1Database)
        const conditions = []

        if (!singleTenant) conditions.push(eq((table as any)[syncIdColumn], syncId))
        if (scope !== undefined && scopeColumn in (table as any)) conditions.push(eq((table as any)[scopeColumn], scope))
        if (softDeleteCol) conditions.push(isNull((table as any)[softDeleteCol]))

        let query = db.select().from(table)
        if (conditions.length === 1) {
          query = query.where(conditions[0]) as any
        } else if (conditions.length > 1) {
          query = query.where(and(...conditions)) as any
        }

        const orderCol = options?.orderByColumn ?? ('createdAt' in (table as any) ? 'createdAt' : ('id' in (table as any) ? 'id' : null))
        const orderDir = options?.orderDirection ?? 'desc'
        if (orderCol && orderCol in (table as any)) {
          const col = (table as any)[orderCol]
          query = (orderDir === 'asc' ? query.orderBy(asc(col)) : query.orderBy(desc(col))) as any
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
      const body = await parseJson(c, insertSchema.and(syncMetaSchema))
      const syncId = getSyncIdFromParam(c)
      const { _clientMutationId, scope, data } = extractMeta(body)
      assertNoProtectedFields(data)
      const userId = await ensureAccess(c, syncId)
      const room = getRoom(c.env, syncId)
      // Inject ownerId on the backend — never trust client-provided owner fields
      // scope is always preserved for broadcast filtering
      const payload = {
        ...data,
        ...(scope !== undefined ? { [scopeColumn]: scope } : {}),
        ...(!singleTenant ? { ownerId: userId } : {}),
      }
      const result = await room.mutate(collection, 'insert', syncId, payload, _clientMutationId, scope, userId)
      return c.json({ success: true, data: result })
    },

    update: async (c: Context) => {
      const body = await parseJson(c, updateSchema.and(syncMetaSchema))
      const { id } = c.req.param()
      const syncId = getSyncIdFromParam(c)
      const { _clientMutationId, scope, data } = extractMeta(body)
      assertNoProtectedFields(data)
      const userId = await ensureAccess(c, syncId)
      const room = getRoom(c.env, syncId)
      const result = await room.mutate(collection, 'update', syncId, { id, data }, _clientMutationId, scope, userId)
      return c.json({ success: true, data: result })
    },

    remove: async (c: Context) => {
      const query = await parseQuery(c, syncMetaSchema)
      const { id } = c.req.param()
      const { _clientMutationId, scope } = query
      const syncId = getSyncIdFromParam(c)
      const userId = await ensureAccess(c, syncId)
      const room = getRoom(c.env, syncId)
      await room.mutate(collection, 'delete', syncId, { id }, _clientMutationId, scope, userId)
      return c.json({ success: true })
    },

    bulkCreate: async (c: Context) => {
      const body = await parseJson(c, bulkInsertSchema(insertSchema))
      const syncId = getSyncIdFromParam(c)
      const { _clientMutationId, scope, items } = body
      const userId = await ensureAccess(c, syncId)
      const room = getRoom(c.env, syncId)

      console.debug(`[cf-sync-kit] bulk-insert "${collection}" for syncId="${syncId}": ${items.length} items`)

      const payload = (items as Record<string, unknown>[]).map(item => {
        assertNoProtectedFields(item)
        return {
          ...item,
          ...(scope !== undefined ? { [scopeColumn]: scope } : {}),
          ...(!singleTenant && { ownerId: userId })
        }
      })

      const result = await room.mutate(collection, 'bulk-insert', syncId, payload, _clientMutationId, scope, userId)
      return c.json({ success: true, data: result })
    },

    bulkUpdate: async (c: Context) => {
      const body = await parseJson(c, bulkUpdateSchema(updateSchema))
      const syncId = getSyncIdFromParam(c)
      const { _clientMutationId, scope, items } = body
      const userId = await ensureAccess(c, syncId)
      const room = getRoom(c.env, syncId)

      console.debug(`[cf-sync-kit] bulk-update "${collection}" for syncId="${syncId}": ${items.length} items`)

      const payload = (items as { id: string; data: Record<string, unknown> }[]).map(({ id, data }) => {
        assertNoProtectedFields(data)
        return {
          id,
          data,
        }
      })

      const result = await room.mutate(collection, 'bulk-update', syncId, payload, _clientMutationId, scope, userId)
      return c.json({ success: true, data: result })
    },

    bulkDelete: async (c: Context) => {
      const body = await parseJson(c, bulkDeleteSchema)
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
