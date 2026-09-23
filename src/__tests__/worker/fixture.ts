import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import { createDurableObject } from '../../server/create-durable-object'
import { createWebSocketHandler } from '../../server/websocket'
import type { MutationReceipt } from '../../server/DurableObjectBase'
import type { MiddlewareContext } from '../../server/MiddlewareSystem'
import type { WsBroadcastEvent } from '../../shared/events'

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

const { SyncRoom: GeneratedTestRoom } = createDurableObject(collections, {
  className: 'TestRoom',
  mutationReceipts: { ttlMs: 60_000, maxEntries: 2 },
  middleware: [async (ctx, next) => {
    if ((ctx.payload as { title?: string })?.title === 'blocked') return
    await next()
  }],
  authorizeConnection: ({ syncId, userId }) => {
    if (!userId) throw new Error('Unauthorized WebSocket connection')
    if (userId !== syncId) throw new Error('Forbidden WebSocket room')
  },
})

type FaultPoint = 'before-write' | 'receipt' | 'broadcast'

export class TestRoom extends GeneratedTestRoom {
  private faultOnce?: FaultPoint

  setFaultOnce(point: FaultPoint) {
    this.faultOnce = point
  }

  async countReceipts() {
    return (await this.ctx.storage.list({ prefix: 'mutation_' })).size
  }

  async mutateCaptured(
    syncId: string,
    payload: { id: string; title: string; scope?: string },
    mutationId: string,
  ) {
    try {
      return { ok: true as const, result: await this.mutate('todos', 'insert', syncId, payload, mutationId) }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  protected override async beforeRepositoryMutation(context: MiddlewareContext) {
    await super.beforeRepositoryMutation(context)
    if (this.faultOnce === 'before-write') {
      this.faultOnce = undefined
      throw new Error('Injected failure before D1 write')
    }
  }

  protected override async persistMutationReceipt(key: string, receipt: MutationReceipt) {
    if (this.faultOnce === 'receipt') {
      this.faultOnce = undefined
      throw new Error('Injected receipt failure')
    }
    await super.persistMutationReceipt(key, receipt)
  }

  protected override publishMutationEvent(event: WsBroadcastEvent) {
    if (this.faultOnce === 'broadcast') {
      this.faultOnce = undefined
      throw new Error('Injected broadcast failure')
    }
    super.publishMutationEvent(event)
  }
}

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
