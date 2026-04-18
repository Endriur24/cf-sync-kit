import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'

/**
 * Single-tenant configuration - all data is shared.
 * For multi-tenant apps, use syncIdColumn to isolate by user/project.
 */
export const todosTable = sqliteTable('todos', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(strftime('%s', 'now') * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(strftime('%s', 'now') * 1000)`),
})

/**
 * Single-tenant configuration - all data is shared.
 * For multi-tenant apps, use syncIdColumn to isolate by user/project.
 */
export const notesTable = sqliteTable('notes', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content'),
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
  notes: {
    table: notesTable,
    insertSchema: createInsertSchema(notesTable).omit({ id: true, createdAt: true }),
    updateSchema: createInsertSchema(notesTable).omit({ id: true }).partial(),
    selectSchema: createSelectSchema(notesTable),
    singleTenant: true,
  },
} as const
