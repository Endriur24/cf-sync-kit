import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'

export const todosTable = sqliteTable('todos', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull(),
  scope: text('scope').notNull(),
  ownerId: text('owner_id').notNull(),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(strftime('%s', 'now') * 1000)`),
}, (table) => ({
  syncIdScopeIdx: index('todos_project_scope_idx').on(table.project_id, table.scope),
}))

export const collectionsConfig = {
  todos: {
    table: todosTable,
    syncIdColumn: 'project_id',
    insertSchema: createInsertSchema(todosTable).omit({ id: true, createdAt: true, ownerId: true, project_id: true }),
    updateSchema: createInsertSchema(todosTable).omit({ id: true }).partial(),
    selectSchema: createSelectSchema(todosTable),
  },
} as const
