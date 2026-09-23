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

const ownerTodos = sqliteTable('framework_owner_todos', {
  id: text('id').primaryKey(),
  syncId: text('sync_id').notNull(),
  createdBy: text('created_by').notNull(),
  title: text('title').notNull(),
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

const ownerCollections = {
  todos: {
    table: ownerTodos,
    insertSchema: z.object({ title: z.string() }),
    updateSchema: z.object({ title: z.string() }).partial(),
    selectSchema: z.object({ id: z.string(), syncId: z.string(), createdBy: z.string(), title: z.string() }),
    ownerColumn: 'createdBy',
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
  private faultCounts: Partial<Record<FaultPoint, number>> = {}
  private beforeWriteCalls = 0
  private failBeforeWriteOnCall?: number

  setFaultOnce(point: FaultPoint) {
    this.setFaults(point, 1)
  }

  setFaults(point: FaultPoint, count: number) {
    this.faultCounts[point] = count
  }

  setBeforeWriteFaultOnCall(call: number) {
    this.failBeforeWriteOnCall = call
  }

  async countReceipts() {
    return (await this.ctx.storage.list({ prefix: 'mutation_' })).size
  }

  async expireReceipt(mutationId: string) {
    const key = `mutation_todos_${encodeURIComponent(mutationId)}`
    const receipt = await this.ctx.storage.get<MutationReceipt>(key)
    if (!receipt) return false
    await this.ctx.storage.put(key, { ...receipt, expiresAt: Date.now() - 1 })
    return true
  }

  async installLegacyReceipt(
    mutationId: string,
    fingerprint: string,
    result: unknown,
  ) {
    await this.ctx.storage.put(
      `mutation_todos_${encodeURIComponent(mutationId)}`,
      { fingerprint, result },
    )
  }

  async hasReceipt(mutationId: string) {
    return (await this.ctx.storage.get(
      `mutation_todos_${encodeURIComponent(mutationId)}`,
    )) !== undefined
  }

  private consumeFault(point: FaultPoint) {
    const remaining = this.faultCounts[point] ?? 0
    if (remaining <= 0) return false
    this.faultCounts[point] = remaining - 1
    return true
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

  async bulkInsertCaptured(
    syncId: string,
    payload: { id: string; title: string; scope?: string }[],
    mutationId: string,
  ) {
    try {
      return { ok: true as const, result: await this.mutate('todos', 'bulk-insert', syncId, payload, mutationId) }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async scopedMutationCaptured(
    action: 'update' | 'delete',
    syncId: string,
    payload: { id: string; data?: { title?: string } },
    mutationId: string,
    scope?: string,
  ) {
    try {
      return {
        ok: true as const,
        result: await this.mutate('todos', action, syncId, payload, mutationId, scope),
      }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  protected override async beforeRepositoryMutation(context: MiddlewareContext) {
    await super.beforeRepositoryMutation(context)
    this.beforeWriteCalls++
    const failsOnCall = this.failBeforeWriteOnCall === this.beforeWriteCalls
    if (failsOnCall) this.failBeforeWriteOnCall = undefined
    if (failsOnCall || this.consumeFault('before-write')) {
      throw new Error('Injected failure before D1 write')
    }
  }

  protected override async persistMutationReceipt(key: string, receipt: MutationReceipt) {
    if (this.consumeFault('receipt')) {
      throw new Error('Injected receipt failure')
    }
    await super.persistMutationReceipt(key, receipt)
  }

  protected override publishMutationEvent(event: WsBroadcastEvent) {
    if (this.consumeFault('broadcast')) {
      throw new Error('Injected broadcast failure')
    }
    super.publishMutationEvent(event)
  }
}

const { SyncRoom: GeneratedOwnerRoom } = createDurableObject(ownerCollections, {
  className: 'OwnerRoom',
  preset: 'per-user',
})

export class OwnerRoom extends GeneratedOwnerRoom {
  async insertCaptured(
    syncId: string,
    payload: { id: string; title: string; createdBy: string },
    mutationId: string,
    userId: string,
  ) {
    try {
      return {
        ok: true as const,
        result: await this.mutate('todos', 'insert', syncId, payload, mutationId, undefined, userId),
      }
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
    }
  }
}

async function ensureSchema(env: Cloudflare.Env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS framework_todos (id TEXT PRIMARY KEY, sync_id TEXT NOT NULL, title TEXT NOT NULL, scope TEXT)'
  ).run()
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS framework_owner_todos (id TEXT PRIMARY KEY, sync_id TEXT NOT NULL, created_by TEXT NOT NULL, title TEXT NOT NULL)'
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
