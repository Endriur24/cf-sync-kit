import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'

export const todosTable = sqliteTable('todos', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(strftime('%s', 'now') * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(strftime('%s', 'now') * 1000)`),
})

export const collectionsConfig = {
  todos: {
    table: todosTable,
    insertSchema: createInsertSchema(todosTable).omit({ id: true, createdAt: true }),
    updateSchema: createInsertSchema(todosTable).omit({ id: true }).partial(),
    selectSchema: createSelectSchema(todosTable),
    singleTenant: true,
  },
} as const
