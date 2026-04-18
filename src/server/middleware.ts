import { HTTPException } from 'hono/http-exception'
import type { Middleware, MiddlewareContext } from './MiddlewareSystem'
import type { ActionType } from '../shared/types'

/**
 * Creates a sync access validator that enforces per-user syncId pattern.
 * Validates that the syncId matches the authenticated userId.
 *
 * @example
 * // Simple per-user: syncId must equal userId
 * const syncApi = createSyncApi(collectionsConfig, getRoom, {
 *   getUserId: (c) => c.get('userId'),
 *   validateSyncAccess: createDefaultSyncAccessValidator(),
 * })
 *
 * @example
 * // With prefix (e.g., 'user:' prefix in syncId)
 * const syncApi = createSyncApi(collectionsConfig, getRoom, {
 *   getUserId: (c) => c.get('userId'),
 *   validateSyncAccess: createDefaultSyncAccessValidator('user:'),
 * })
 */
export function createDefaultSyncAccessValidator(
  prefix?: string
): (userId: string, syncId: string) => void {
  return (userId, syncId) => {
    const expected = prefix ? `${prefix}${userId}` : userId
    if (syncId !== expected) {
      throw new HTTPException(403, {
        message: `Forbidden: syncId must be '${expected}', got '${syncId}'. ` +
          (prefix ? `The syncId requires the '${prefix}' prefix.` : 'The syncId must match the userId exactly.'),
      })
    }
  }
}

/**
 * Creates a middleware that validates the user has access to the syncId.
 * Typically used to enforce that a user can only access their own sync scope.
 *
 * @param validate - Function that throws if access is denied
 *
 * @example
 * this.use(createSyncAccessMiddleware((userId, syncId) => {
 *   if (syncId !== `user:${userId}`) throw new Error('Forbidden')
 * }))
 */
export function createSyncAccessMiddleware(
  validate: (userId: string, syncId: string) => void | Promise<void>
): Middleware {
  return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    if (!ctx.userId) {
      throw new HTTPException(401, { message: 'Unauthorized' })
    }
    await validate(ctx.userId, ctx.syncId)
    await next()
  }
}

/**
 * Creates an authorization middleware.
 * Checks that the context has a valid userId.
 *
 * @example
 * this.use(createAuthMiddleware((ctx) => getUserFromToken(ctx)))
 */
export function createAuthMiddleware(
  getUserId: (ctx: MiddlewareContext) => string | null | Promise<string | null>
): Middleware {
  return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    const userId = await getUserId(ctx)
    if (!userId) {
      throw new HTTPException(401, { message: 'Unauthorized: missing user identity' })
    }
    ctx.userId = userId
    await next()
  }
}

/**
 * Creates a collection filtering middleware.
 * Restricts which collections a project can access.
 *
 * @example
 * this.use(createCollectionFilterMiddleware(['todos', 'notes']))
 */
export function createCollectionFilterMiddleware(allowedCollections: string[]): Middleware {
  const allowed = new Set(allowedCollections)
  return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    if (!allowed.has(ctx.collection)) {
      throw new HTTPException(403, { message: `Collection '${ctx.collection}' is not allowed for action '${ctx.action}'` })
    }
    await next()
  }
}

/**
 * Logger interface for middleware logging.
 */
export interface MutationLogger {
  info(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

/**
 * Default logger using console methods.
 */
export const defaultMutationLogger: MutationLogger = {
  info: (message, data) => console.log(`[Mutation] ${message}`, data ?? ''),
  error: (message, data) => console.error(`[Mutation Error] ${message}`, data ?? ''),
}

/**
 * Creates a logging middleware for debugging mutations.
 *
 * @example
 * this.use(createLoggingMiddleware())
 *
 * @example
 * // With custom logger (e.g., Winston, Pino)
 * this.use(createLoggingMiddleware({
 *   logger: winstonLogger
 * }))
 */
export function createLoggingMiddleware(options?: { logger?: MutationLogger }): Middleware {
  const logger = options?.logger ?? defaultMutationLogger

  return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    const start = Date.now()
    logger.info(`${ctx.action} on ${ctx.collection}`, { syncId: ctx.syncId })
    try {
      await next()
      const duration = Date.now() - start
      logger.info(`Completed in ${duration}ms`)
    } catch (error) {
      logger.error(`Failed after ${Date.now() - start}ms`, {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}

/**
 * Requires that ctx.userId is set (user must be authenticated).
 * Throw if no userId is present.
 *
 * @example
 * this.use(requireAuth())
 */
export function requireAuth(): Middleware {
  return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    if (!ctx.userId) {
      throw new HTTPException(401, { message: 'Unauthorized' })
    }
    await next()
  }
}

/**
 * Options for requireOwner middleware.
 */
export interface RequireOwnerOptions {
  /** Check ownership on update/delete operations (default: false for per-user models) */
  checkOnUpdateDelete?: boolean
  /** Name of the owner field in payload (default: 'ownerId') */
  ownerField?: string
  /**
   * Custom async function to verify record ownership for update/delete operations.
   * Called with the middleware context. Return true if user owns the record, false to deny.
   * Use this for shared scopes where syncId isolation is not enough.
   *
   * @example
   * requireOwner({
   *   checkOnUpdateDelete: true,
   *   ownerCheckQuery: async (ctx) => {
   *     const db = drizzle(ctx.env.DB)
   *     const record = await db.select().from(todos).where(eq(todos.id, ctx.payload.id)).get()
   *     return record?.ownerId === ctx.userId
   *   }
   * })
   */
  ownerCheckQuery?: (ctx: MiddlewareContext) => Promise<boolean>
}

/**
 * Requires that the user is the owner of the mutated record.
 *
 * For insert: verifies that ownerId (injected by the backend) matches ctx.userId.
 * For update/delete: passes through — ownership is enforced by syncId isolation
 * via createSyncAccessMiddleware. For shared scopes, add custom middleware
 * that queries the database to verify record ownership.
 *
 * Should be used after requireAuth() and createSyncAccessMiddleware().
 *
 * @param options - Configuration options or ownerField string (for backwards compatibility)
 * @param options.checkOnUpdateDelete - Check ownership on update/delete (default: false)
 * @param options.ownerField - Name of the owner field in payload (default: 'ownerId')
 *
 * @example
 * // Per-user model (no update/delete check)
 * this.use(requireOwner())
 *
 * @example
 * // Shared scope model (with update/delete check)
 * this.use(requireOwner({ checkOnUpdateDelete: true }))
 */
export function requireOwner(options: RequireOwnerOptions | string = {}): Middleware {
  const opts: RequireOwnerOptions = typeof options === 'string'
    ? { ownerField: options }
    : options

  const { checkOnUpdateDelete = false, ownerField = 'ownerId', ownerCheckQuery } = opts

  return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    if (!ctx.userId) {
      throw new HTTPException(401, { message: 'Unauthorized' })
    }

    const payload = ctx.payload as Record<string, unknown>

    switch (ctx.action) {
      case 'insert': {
        const recordOwner = payload[ownerField] as string | undefined
        if (recordOwner && recordOwner !== ctx.userId) {
          throw new HTTPException(403, { message: 'Forbidden: you can only create your own records (ownerId mismatch)' })
        }
        break
      }

      case 'bulk-insert': {
        const items = ctx.payload as Record<string, unknown>[]
        for (const item of items) {
          const recordOwner = item[ownerField] as string | undefined
          if (recordOwner && recordOwner !== ctx.userId) {
            throw new HTTPException(403, {
              message: 'Forbidden: you can only create your own records (ownerId mismatch in bulk-insert)',
            })
          }
        }
        break
      }

      case 'update':
      case 'delete':
        if (checkOnUpdateDelete) {
          if (ownerCheckQuery) {
            const isOwner = await ownerCheckQuery(ctx)
            if (!isOwner) {
              throw new HTTPException(403, { message: 'Forbidden: you do not own this record' })
            }
          } else {
            throw new HTTPException(500, {
              message: `Misconfiguration: requireOwner with checkOnUpdateDelete=true requires ownerCheckQuery for collection "${ctx.collection}". Provide a custom ownership verification function.`,
            })
          }
        }
        break

      case 'bulk-update':
      case 'bulk-delete':
        if (checkOnUpdateDelete) {
          if (ownerCheckQuery) {
            // For bulk operations, run ownerCheckQuery for each item
            const items = ctx.action === 'bulk-update'
              ? (ctx.payload as { id: string; data: Record<string, unknown> }[])
              : (ctx.payload as string[]).map(id => ({ id }))
            for (const item of items) {
              const itemCtx: MiddlewareContext = { ...ctx, payload: item }
              const isOwner = await ownerCheckQuery(itemCtx)
              if (!isOwner) {
                throw new HTTPException(403, {
                  message: `Forbidden: you do not own record ${(item as any).id}`,
                })
              }
            }
          } else {
            throw new HTTPException(500, {
              message: `Misconfiguration: requireOwner with checkOnUpdateDelete=true requires ownerCheckQuery for bulk operations on collection "${ctx.collection}".`,
            })
          }
        }
        break
    }

    await next()
  }
}

/**
 * Advanced, action-specific collection access control middleware.
 * Allows granular permissions per action (insert, update, delete, bulk-*, etc.).
 *
 * @example
 * this.use(createCollectionAccessMiddleware({
 *   photos: {
 *     insert: true,                                 // everyone can create
 *     update: (ctx) => ctx.access?.role !== 'viewer',
 *     delete: (ctx) => ['owner', 'admin'].includes(ctx.access?.role),
 *     'bulk-delete': (ctx) => ctx.access?.role === 'owner',
 *     '*': true                                     // fallback for read + other actions
 *   },
 *   selectionBuckets: {
 *     '*': (ctx) => ['editor', 'owner', 'admin'].includes(ctx.access?.role)
 *   }
 * }))
 */
export function createCollectionAccessMiddleware(
  rules: {
    [collection: string | '*']: {
      [action in ActionType | '*']?:
        | boolean
        | ((ctx: MiddlewareContext) => boolean | Promise<boolean>)
    }
  }
): Middleware {
  const ruleKeys = Object.keys(rules)
  if (ruleKeys.length === 0) {
    throw new Error('createCollectionAccessMiddleware: at least one collection rule must be defined')
  }

  return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    const collectionRules = rules[ctx.collection] || rules['*']
    if (!collectionRules) {
      throw new HTTPException(403, {
        message: `No access rules defined for collection "${ctx.collection}"`,
      })
    }

    // Check exact action first (e.g. 'delete')
    let rule = collectionRules[ctx.action]

    // If no rule for specific action → check wildcard '*'
    if (rule === undefined) {
      rule = collectionRules['*']
    }

    // Deny-by-default: if no rule for this action and no wildcard, reject
    if (rule === undefined) {
      throw new HTTPException(403, {
        message: `Forbidden: no access rule defined for ${ctx.action} on collection "${ctx.collection}"`,
      })
    }

    if (rule === false) {
      throw new HTTPException(403, {
        message: `Forbidden: ${ctx.action} on collection "${ctx.collection}"`,
      })
    }

    if (typeof rule === 'function') {
      const allowed = await rule(ctx)
      if (!allowed) {
        throw new HTTPException(403, {
          message: `Forbidden: ${ctx.action} on collection "${ctx.collection}"`,
        })
      }
    }

    // rule === true → allow
    await next()
  }
}