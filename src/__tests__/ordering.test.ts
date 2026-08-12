import { describe, it, expect } from 'vitest'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import { Repository } from '../server/Repository'
import { defineCollections } from '../shared/types'

const itemsTable = sqliteTable('items', {
  id: text('id').primaryKey(),
  syncId: text('sync_id').notNull(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
})

describe('Repository sorting configuration', () => {
  it('defaults to orderByColumn null and orderDirection desc', () => {
    const repo = new Repository({} as any, itemsTable, 'items')
    expect(repo.orderByColumn).toBeNull()
    expect(repo.orderDirection).toBe('desc')
  })

  it('supports custom orderByColumn and orderDirection from config', () => {
    const config = defineCollections({
      items: {
        table: itemsTable,
        insertSchema: z.object({ name: z.string() }),
        updateSchema: z.object({ name: z.string().optional() }),
        selectSchema: z.object({ id: z.string(), name: z.string() }),
        orderByColumn: 'name',
        orderDirection: 'asc',
      },
    })

    const itemConfig = config.items as import('../shared/types').CollectionConfig
    const repo = new Repository(
      {} as any,
      itemConfig.table,
      'items',
      itemConfig.syncIdColumn,
      itemConfig.singleTenant,
      itemConfig.autoTimestamp,
      itemConfig.softDeleteColumn,
      itemConfig.scopeColumn,
      itemConfig.orderByColumn,
      itemConfig.orderDirection
    )

    expect(repo.orderByColumn).toBe('name')
    expect(repo.orderDirection).toBe('asc')
  })
})
