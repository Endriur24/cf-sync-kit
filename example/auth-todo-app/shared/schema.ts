import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'

export const todosTable = sqliteTable('todos', {
  id: text('id').primaryKey(),
  owner_id: text('owner_id').notNull(),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(strftime('%s', 'now') * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(strftime('%s', 'now') * 1000)`),
}, (table) => ({
  ownerIdIdx: index('todos_owner_id_idx').on(table.owner_id),
}))

export const collectionsConfig = {
  todos: {
    table: todosTable,
    syncIdColumn: 'owner_id',
    insertSchema: createInsertSchema(todosTable).omit({ id: true, createdAt: true, owner_id: true }),
    updateSchema: createInsertSchema(todosTable).omit({ id: true }).partial(),
    selectSchema: createSelectSchema(todosTable),
  },
} as const
