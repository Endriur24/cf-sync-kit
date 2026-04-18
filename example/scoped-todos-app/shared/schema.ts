import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'

/**
 * Single-tenant configuration — all lists are shared.
 * Scope filtering is used to isolate broadcasts per list.
 */
export const listsTable = sqliteTable('lists', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  color: text('color').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(strftime('%s', 'now') * 1000)`),
})

/**
 * Single-tenant configuration — all todos are shared.
 * The `scope` column isolates broadcasts per list, not syncId.
 * Foreign key with ON DELETE CASCADE ensures todos are removed when their list is deleted.
 */
export const scopedTodosTable = sqliteTable('scoped_todos', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull().references(() => listsTable.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(strftime('%s', 'now') * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(strftime('%s', 'now') * 1000)`),
}, (table) => ({
  scopeIdx: index('scoped_todos_scope_idx').on(table.scope),
}))

export const collectionsConfig = {
  lists: {
    table: listsTable,
    insertSchema: createInsertSchema(listsTable).omit({ id: true, createdAt: true }),
    updateSchema: createInsertSchema(listsTable).omit({ id: true, createdAt: true }).partial(),
    selectSchema: createSelectSchema(listsTable),
    singleTenant: true,
  },
  scopedTodos: {
    table: scopedTodosTable,
    insertSchema: createInsertSchema(scopedTodosTable).omit({ id: true, createdAt: true }),
    updateSchema: createInsertSchema(scopedTodosTable).omit({ id: true }).partial(),
    selectSchema: createSelectSchema(scopedTodosTable),
    singleTenant: true,
  },
} as const
