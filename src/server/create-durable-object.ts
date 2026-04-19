import { DurableObjectBase } from './DurableObjectBase'
import { Repository } from './Repository'
import type { CollectionsMap } from '../shared/types'
import type { Middleware } from './MiddlewareSystem'
import { requireAuth, requireOwner, createSyncAccessMiddleware, createDefaultSyncAccessValidator } from './middleware'

type DurableObjectPreset = 'per-user' | 'shared'

export interface DurableObjectClass {
  new(ctx: DurableObjectState, env: Bindings): DurableObjectBase
}

export interface CreateDurableObjectResult<TConfig extends CollectionsMap> {
  SyncRoom: DurableObjectClass
}

/**
 * Creates a Durable Object class pre-configured with repositories from your collections.
 *
 * @param collectionsConfig - Your collections configuration object
 * @param options - Optional configuration
 * @param options.className - Name for the generated class (default: 'SyncRoom')
 * @param options.middleware - Array of middleware to register after preset middleware
 * @param options.middlewareBefore - Array of middleware to register before preset middleware
 * @param options.preset - Pre-configured middleware preset
 *
 * **Preset: 'per-user'**
 *
 * Automatically adds authentication, syncId validation, and ownership middleware.
 *
 * Requirements:
 * - syncId must equal the authenticated userId (e.g. syncId = 'alice' when userId = 'alice')
 * - Your table's syncIdColumn (e.g. `owner_id`) stores the userId for tenant isolation
 * - Each user has their own isolated data — no sharing between users
 *
 * What happens if misconfigured:
 * - If syncId does NOT match userId → 403 Forbidden on every mutation
 * - If table lacks the syncIdColumn → insert will fail with DB error
 * - If you need shared/project scopes → do NOT use this preset, use custom middleware
 *
 * Middleware execution order:
 * 1. middlewareBefore (runs first, before preset)
 * 2. preset middleware (if enabled)
 * 3. middleware (runs last, after preset)
 *
 * @example
 * // Per-user model — one-liner!
 * export const { SyncRoom: UserRoom } = createDurableObject(collectionsConfig, {
 *   className: 'UserRoom',
 *   preset: 'per-user'
 * })
 *
 * @example
 * // Shared model — custom middleware
 * export const { SyncRoom: ProjectRoom } = createDurableObject(collectionsConfig, {
 *   className: 'ProjectRoom',
 *   middleware: [requireAuth(), injectProjectAccessMiddleware(), ...],
 * })
 *
 * @example
 * // Custom middleware before preset (e.g., logging before auth)
 * export const { SyncRoom: LoggedRoom } = createDurableObject(collectionsConfig, {
 *   preset: 'per-user',
 *   middlewareBefore: [createLoggingMiddleware()],
 *   middleware: [customPostAuthMiddleware()]
 * })
 */
export function createDurableObject<TConfig extends CollectionsMap>(
  collectionsConfig: TConfig,
  options?: { className?: string; middleware?: Middleware[]; middlewareBefore?: Middleware[]; preset?: DurableObjectPreset; dbName?: string }
): CreateDurableObjectResult<TConfig> {
  const className = options?.className ?? 'SyncRoom'
  const dbName = options?.dbName ?? 'DB'

  const presetMiddleware: Middleware[] = []
  if (options?.preset === 'per-user') {
    presetMiddleware.push(
      requireAuth(),
      createSyncAccessMiddleware(createDefaultSyncAccessValidator()),
      requireOwner({ checkOnUpdateDelete: false })
    )
  }

  class SyncRoom extends DurableObjectBase {
    constructor(ctx: DurableObjectState, env: Bindings) {
      super(ctx, env)
      Object.entries(collectionsConfig).forEach(([name, config]) => {
        const singleTenant = (config as any).singleTenant ?? false
        if (singleTenant && config.syncIdColumn !== undefined) {
          console.warn(
            `[cf-sync-kit] Collection "${name}" has both singleTenant and syncIdColumn. ` +
            `singleTenant takes precedence — syncIdColumn will be ignored.`
          )
        }
        this.registerRepository(
          new Repository(
            env[dbName as keyof typeof env] as D1Database,
            config.table as any,
            name,
            config.syncIdColumn ?? 'syncId',
            singleTenant,
            (config as any).autoTimestamp ?? true
          )
        )
      })
      // Execution order: middlewareBefore → preset → middleware
      options?.middlewareBefore?.forEach(m => this.use(m))
      presetMiddleware.forEach(m => this.use(m))
      options?.middleware?.forEach(m => this.use(m))
    }
  }

  Object.defineProperty(SyncRoom, 'name', { value: className })

  return { SyncRoom }
}

/**
 * Creates a room resolver function for a Durable Object namespace.
 * The returned function only needs syncId — env is already captured.
 *
 * @param namespace - Durable Object namespace binding from env
 *
 * @example
 * const syncApi = createSyncApi(collectionsConfig, createGetRoomFn(env.PROJECT_ROOM))
 */
export function createGetRoomFn<T extends DurableObjectBase>(
  namespace: DurableObjectNamespace<T>
) {
  return (env: Bindings, syncId: string) => {
    const id = namespace.idFromName(syncId)
    return namespace.get(id)
  }
}
