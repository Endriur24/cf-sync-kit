import { eq, and, inArray } from 'drizzle-orm'
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { Column } from 'drizzle-orm'

type TableWithId = SQLiteTable & { id: Column<any, any, any> }

/**
 * Safely accesses a table column by name.
 * Drizzle tables are dynamic objects — this helper avoids scattered `as any` casts.
 */
function getTableColumn(table: SQLiteTable, columnName: string): Column {
  return (table as unknown as Record<string, Column>)[columnName]
}

/**
 * Type for dynamic insert payloads.
 * Drizzle's strict insert types require exact schema match, but our payloads
 * are built dynamically at runtime and validated by Zod at the router level.
 */
type DynamicInsertValue = Record<string, unknown>

export class Repository<TTable extends TableWithId> {
  protected db: DrizzleD1Database
  public readonly syncIdColumn: string
  public readonly singleTenant: boolean
  public readonly autoTimestamp: boolean

  /**
   * @param d1 - Cloudflare D1 database binding
   * @param table - Drizzle table definition
   * @param collectionName - Name used to identify this collection in events
   * @param syncIdColumn - Name of the column used as sync/tenant ID (default: "syncId")
   * @param singleTenant - When true, syncIdColumn is ignored and data is not scoped
   * @param autoTimestamp - When true, automatically sets createdAt/updatedAt timestamps (default: true)
   */
  constructor(
    d1: D1Database,
    public table: TTable,
    public collectionName: string,
    syncIdColumn = 'syncId',
    singleTenant = false,
    autoTimestamp = true
  ) {
    this.db = drizzle(d1)
    this.syncIdColumn = syncIdColumn
    this.singleTenant = singleTenant
    this.autoTimestamp = autoTimestamp
  }

  private whereSyncId(syncId: string) {
    if (this.singleTenant) return undefined
    return eq(getTableColumn(this.table, this.syncIdColumn), syncId)
  }

  /**
   * Creates a new entity.
   * Auto-generates id and sets syncId for tenant isolation (unless singleTenant mode).
   */
  async create(syncId: string, data: Record<string, unknown>) {
    const id = data.id || crypto.randomUUID()
    const now = new Date()
    const payload: DynamicInsertValue = {
      ...data,
      id,
      ...(this.singleTenant ? {} : { [this.syncIdColumn]: syncId }),
      ...(this.autoTimestamp ? { createdAt: now, updatedAt: now } : {}),
    }

    try {
      // Dynamic payload — types are validated by Zod schemas at the router level
      const results = await this.db.insert(this.table).values(payload as any).returning()
      return results[0] || null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[Repository.create] Failed to create entity in ${this.collectionName}: ${message}`)
    }
  }

  /**
   * Finds a single entity by id, scoped to syncId.
   */
  async findById(syncId: string, id: string) {
    const whereClause = this.singleTenant
      ? eq(this.table.id, id)
      : and(eq(this.table.id, id), this.whereSyncId(syncId))

    try {
      const results = await this.db
        .select()
        .from(this.table)
        .where(whereClause)

      return results[0] || null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[Repository.findById] Failed to find entity in ${this.collectionName}: ${message}`)
    }
  }

  /**
   * Finds all entities for a sync scope.
   */
  async findAll(syncId: string) {
    if (this.singleTenant) {
      try {
        const results = await this.db.select().from(this.table)
        return results || []
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`[Repository.findAll] Failed to find entities in ${this.collectionName}: ${message}`)
      }
    }
    try {
      const results = await this.db
        .select()
        .from(this.table)
        .where(this.whereSyncId(syncId))

      return results || []
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[Repository.findAll] Failed to find entities in ${this.collectionName}: ${message}`)
    }
  }

  /**
   * Updates an entity by id, scoped to syncId (unless singleTenant mode).
   * Automatically sets updatedAt timestamp when autoTimestamp is enabled.
   */
  async update(syncId: string, id: string, data: Record<string, unknown>) {
    const updateData: Record<string, unknown> = {
      ...data,
      ...(this.autoTimestamp ? { updatedAt: new Date() } : {}),
    }

    const whereClause = this.singleTenant
      ? eq(this.table.id, id)
      : and(eq(this.table.id, id), this.whereSyncId(syncId))

    try {
      const results = await this.db
        .update(this.table)
        .set(updateData)
        .where(whereClause)
        .returning()

      return results[0] || null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[Repository.update] Failed to update entity in ${this.collectionName}: ${message}`)
    }
  }

  /**
   * Deletes an entity by id, scoped to syncId (unless singleTenant mode).
   */
  async delete(syncId: string, id: string) {
    const whereClause = this.singleTenant
      ? eq(this.table.id, id)
      : and(eq(this.table.id, id), this.whereSyncId(syncId))

    try {
      await this.db
        .delete(this.table)
        .where(whereClause)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[Repository.delete] Failed to delete entity in ${this.collectionName}: ${message}`)
    }
  }

  /**
   * Creates multiple entities in a single batch.
   * Uses dynamic batch size based on table column count to stay under D1's ~100 bound parameters limit.
   */
  async bulkCreate(syncId: string, items: Record<string, unknown>[]) {
    if (items.length === 0) return []

    const now = new Date()
    const payloads = items.map((item) => ({
      ...item,
      id: item.id || crypto.randomUUID(),
      ...(this.singleTenant ? {} : { [this.syncIdColumn]: syncId }),
      ...(this.autoTimestamp ? { createdAt: now, updatedAt: now } : {}),
    }))

    // Use table column count (not payload keys) since drizzle includes default columns in INSERT
    const columnsCount = Object.keys(this.table).length
    const batchSize = Math.max(5, Math.floor(90 / columnsCount))
    const allResults: unknown[] = []

    try {
      for (let i = 0; i < payloads.length; i += batchSize) {
        const batch = payloads.slice(i, i + batchSize)
        // Dynamic payloads — types are validated by Zod schemas at the router level
        const results = await this.db
          .insert(this.table)
          .values(batch as unknown as any[])
          .returning()

        allResults.push(...results)
      }
      return allResults
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[Repository.bulkCreate] Failed to create entities: ${message}`)
    }
  }

  /**
   * Updates multiple entities using db.batch() for D1.
   * Sends all update queries in a single request to reduce latency.
   * Uses dynamic batch size to stay within D1's ~100 bound parameters limit.
   *
   * Expects items in format: { id: string, data: Record<string, unknown> }
   */
  async bulkUpdate(syncId: string, items: { id: string; data: Record<string, unknown> }[]) {
    if (items.length === 0) return []

    const now = new Date()
    const allResults: unknown[] = []

    // Calculate params per query: id (1) + syncId (1 if not singleTenant) + data keys + updatedAt (1 if autoTimestamp)
    // Use the first item to estimate, then cap conservatively
    const firstDataKeys = Object.keys(items[0]?.data || {}).length
    const paramsPerQuery = 1 + (this.singleTenant ? 0 : 1) + firstDataKeys + (this.autoTimestamp ? 1 : 0)
    const batchSize = Math.max(5, Math.floor(90 / paramsPerQuery))

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize)

      try {
        // Build batch queries - each update is a separate statement
        const queries = batch.map((item) => {
          const { id, data } = item
          const updateData: Record<string, unknown> = {
            ...data,
            ...(this.autoTimestamp ? { updatedAt: now } : {}),
          }

          const whereClause = this.singleTenant
            ? eq(this.table.id, id)
            : and(eq(this.table.id, id), this.whereSyncId(syncId))

          return this.db
            .update(this.table)
            .set(updateData)
            .where(whereClause)
            .returning()
        })

        // Execute all updates in a single batch request
        const results = await this.db.batch(queries as [typeof queries[0], ...typeof queries])
        for (const result of results) {
          if (Array.isArray(result) && result[0]) {
            allResults.push(result[0])
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`[Repository.bulkUpdate] Failed to update batch starting at index ${i}: ${message}`)
      }
    }

    return allResults
  }

  /**
   * Deletes multiple entities by their ids.
   * Batches DELETE queries with IN() clauses to stay within D1's bound parameters limit.
   */
  async bulkDelete(syncId: string, ids: string[]) {
    if (ids.length === 0) return

    const batchSize = 100
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize)
      try {
        const whereClause = this.singleTenant
          ? inArray(this.table.id, batch)
          : and(this.whereSyncId(syncId), inArray(this.table.id, batch))

        await this.db
          .delete(this.table)
          .where(whereClause)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`[Repository.bulkDelete] Failed to delete batch starting at index ${i}: ${message}`)
      }
    }
  }

  /**
   * Finds multiple entities by their ids, scoped to syncId (unless singleTenant mode).
   */
  async findByIds(syncId: string, ids: string[]) {
    if (ids.length === 0) return []

    const whereClause = this.singleTenant
      ? inArray(this.table.id, ids)
      : and(this.whereSyncId(syncId), inArray(this.table.id, ids))

    try {
      const results = await this.db
        .select()
        .from(this.table)
        .where(whereClause)

      return results
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[Repository.findByIds] Failed to find entities in ${this.collectionName}: ${message}`)
    }
  }
}
