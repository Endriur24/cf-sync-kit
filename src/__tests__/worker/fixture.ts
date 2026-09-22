import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import { createDurableObject } from '../../server/create-durable-object'
import { createWebSocketHandler } from '../../server/websocket'

const todos = sqliteTable('framework_todos', {
  id: text('id').primaryKey(),
  syncId: text('sync_id').notNull(),
  title: text('title').notNull(),
  scope: text('scope'),
})

const schema = z.object({ title: z.string(), scope: z.string().optional() })
const collections = {
  todos: {
    table: todos,
    insertSchema: schema,
    updateSchema: schema.partial(),
    selectSchema: schema.extend({ id: z.string(), syncId: z.string() }),
    autoTimestamp: false,
  },
}

export const { SyncRoom: TestRoom } = createDurableObject(collections, {
  className: 'TestRoom',
  middleware: [async (ctx, next) => {
    if ((ctx.payload as { title?: string })?.title === 'blocked') return
    await next()
  }],
  authorizeConnection: ({ syncId, userId }) => {
    if (!userId) throw new Error('Unauthorized WebSocket connection')
    if (userId !== syncId) throw new Error('Forbidden WebSocket room')
  },
})

async function ensureSchema(env: Cloudflare.Env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS framework_todos (id TEXT PRIMARY KEY, sync_id TEXT NOT NULL, title TEXT NOT NULL, scope TEXT)'
  ).run()
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    await ensureSchema(env)
    const url = new URL(request.url)
    if (url.pathname.startsWith('/parties/')) {
      const handler = createWebSocketHandler(env.TEST_ROOM, {
        party: 'main',
        authorize: ({ request, syncId }) => {
          if (request.headers.get('Authorization') !== `Bearer ${syncId}`) {
            return new Response('Unauthorized', { status: 401 })
          }
          return syncId
        },
      })
      return handler(request)
    }
    return new Response('worker fixture')
  },
}
