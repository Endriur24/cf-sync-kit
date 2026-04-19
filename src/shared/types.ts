import type { z } from 'zod'

/**
 * Default sync ID used for single-tenant apps where no explicit syncId is provided.
 */
export const DEFAULT_SYNC_ID = '_default' as const

/**
 * Supported mutation action types for collections.
 */
export type ActionType = 'insert' | 'update' | 'delete' | 'bulk-insert' | 'bulk-update' | 'bulk-delete'

/**
 * Configuration for a collection, defining the Drizzle table and Zod schemas.
 * @template TTable - Drizzle table type
 * @template TInsert - Type inferred from insert schema
 * @template TUpdate - Type inferred from update schema
 * @template TEntity - Type inferred from select schema
 */
export type CollectionConfig<TTable = any, TInsert = any, TUpdate = any, TEntity = any> = {
  /** Drizzle table definition */
  table: TTable
  /** Zod schema for validating insert operations */
  insertSchema: z.ZodType<TInsert>
  /** Zod schema for validating update operations */
  updateSchema: z.ZodType<TUpdate>
  /** Zod schema for validating/selecting entities */
  selectSchema: z.ZodType<TEntity>

  /** Name of the Drizzle table column used as sync/tenant ID (default: "syncId") */
  syncIdColumn?: string
  /** When true, syncIdColumn is ignored and all data is shared (no multi-tenant isolation) */
  singleTenant?: boolean
  /** When true, automatically sets createdAt/updatedAt timestamps (default: true) */
  autoTimestamp?: boolean
  /** Name of the column for soft-delete (e.g. "deletedAt") or `true` to use "deletedAt" as default */
  softDeleteColumn?: string | boolean
}

/**
 * Map of collection names to their configurations.
 * Used as the primary type parameter for type-safe hooks.
 */
export type CollectionsMap = Record<string, {
  table: any
  insertSchema: z.ZodType<any>
  updateSchema: z.ZodType<any>
  selectSchema: z.ZodType<any>
  syncIdColumn?: string
  singleTenant?: boolean
  autoTimestamp?: boolean
  softDeleteColumn?: string | boolean
}>

/**
 * Infers the insert type for a specific collection.
 * @example
 * type TodoInsert = InferInsert<typeof collectionsConfig, 'todos'>
 */
export type InferInsert<T extends CollectionsMap, K extends keyof T> =
  T[K] extends { insertSchema: infer S }
    ? S extends z.ZodType<infer I>
      ? I
      : never
    : never

/**
 * Infers the update type for a specific collection.
 * @example
 * type TodoUpdate = InferUpdate<typeof collectionsConfig, 'todos'>
 */
export type InferUpdate<T extends CollectionsMap, K extends keyof T> =
  T[K] extends { updateSchema: infer S }
    ? S extends z.ZodType<infer U>
      ? U
      : never
    : never

/**
 * Infers the entity (select) type for a specific collection.
 * @example
 * type Todo = InferEntity<typeof collectionsConfig, 'todos'>
 */
export type InferEntity<T extends CollectionsMap, K extends keyof T> =
  T[K] extends { selectSchema: infer S }
    ? S extends z.ZodType<infer E>
      ? E
      : never
    : never

/**
 * Payload for a mutation operation.
 */
export type MutationPayload<TAction extends ActionType = ActionType> = {
  action: TAction
  payload: any
  clientMutationId?: string
}

/**
 * Tracks pending optimistic mutations on the client.
 */
export type PendingMutationInfo = {
  entityId?: string
  action: 'insert' | 'update' | 'delete' | 'bulk-insert' | 'bulk-update' | 'bulk-delete'
}

/**
 * WebSocket connection status for the client.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

/**
 * Collection name identifier.
 */
export type CollectionName = string

/**
 * Scope string for filtering broadcasts within a collection.
 * Allows multiple logical groups to share the same WebSocket/DO
 * without cross-contamination of updates.
 */
export type Scope = string | undefined

/**
 * Maps all collection names to their entity types.
 * @example
 * type Entities = EntityMap<typeof collectionsConfig>
 * // { todos: Todo; notes: Note }
 */
export type EntityMap<T extends CollectionsMap> = {
  [K in keyof T]: InferEntity<T, K>
}

/**
 * Maps all collection names to their insert types.
 * Note: syncIdColumn is injected server-side — omit it from your insertSchema.
 * @example
 * type Inserts = InsertMap<typeof collectionsConfig>
 */
export type InsertMap<T extends CollectionsMap> = {
  [K in keyof T]: InferInsert<T, K>
}

/**
 * Maps all collection names to their update types.
 * @example
 * type Updates = UpdateMap<typeof collectionsConfig>
 */
export type UpdateMap<T extends CollectionsMap> = {
  [K in keyof T]: InferUpdate<T, K>
}

/**
 * Extracts the entity type with a guaranteed id field.
 * Useful for typing cache operations without `as any` casts.
 */
export type WithId<T = unknown> = T & { id: string }

/**
 * Collection name keys from a CollectionsMap.
 * @example
 * type Names = CollectionKeys<typeof collectionsConfig> // 'todos' | 'notes'
 */
export type CollectionKeys<T extends CollectionsMap> = keyof T & string

/**
 * Custom error class for sync-related errors.
 * Provides structured error handling with error codes and optional details.
 */
export class SyncError extends Error {
  constructor(
    message: string,
    public code: string,
    public status?: number,
    public details?: unknown
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

/**
 * Type guard to check if an error is a SyncError.
 */
export function isSyncError(err: unknown): err is SyncError {
  return err instanceof SyncError
}

/**
 * Helper function to define collections config with full type inference.
 * Alternative to `as const` — provides better IDE autocomplete and type checking.
 *
 * @example
 * export const collectionsConfig = defineCollections({
 *   todos: {
 *     table: todosTable,
 *     syncIdColumn: 'project_id',
 *     insertSchema: createInsertSchema(todosTable).omit({ id: true, createdAt: true, project_id: true }),
 *     updateSchema: createInsertSchema(todosTable).omit({ id: true }).partial(),
 *     selectSchema: createSelectSchema(todosTable),
 *   },
 * })
 */
export function defineCollections<T extends CollectionsMap>(config: T) {
  for (const [name, cfg] of Object.entries(config)) {
    if (cfg.singleTenant === true && cfg.syncIdColumn !== undefined) {
      throw new Error(
        `[cf-sync-kit] Collection "${name}" has both singleTenant and syncIdColumn set. ` +
        `These are mutually exclusive — use singleTenant for shared data, or syncIdColumn for isolated data.`
      )
    }
  }
  return config
}
