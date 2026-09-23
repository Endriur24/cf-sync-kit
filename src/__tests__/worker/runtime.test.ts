import { env, evictDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import { createDurableObject } from '../../server/create-durable-object'

describe('Workers runtime harness', () => {
  async function prepareSchema() {
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS framework_todos (id TEXT PRIMARY KEY, sync_id TEXT NOT NULL, title TEXT NOT NULL, scope TEXT)`)
  }

  it('fails fast when the per-user ownerColumn is absent from the table', () => {
    const table = sqliteTable('missing_owner', {
      id: text('id').primaryKey(),
      syncId: text('sync_id').notNull(),
      title: text('title').notNull(),
    })
    const schema = z.object({ title: z.string() })

    expect(() => createDurableObject({
      todos: {
        table,
        insertSchema: schema,
        updateSchema: schema.partial(),
        selectSchema: schema,
        ownerColumn: 'createdBy',
      },
    }, { preset: 'per-user' })).toThrow(
      'Collection "todos" uses the per-user preset but its table does not contain ownerColumn "createdBy"'
    )
  })

  it('executes the real DurableObjectBase and Repository against D1', async () => {
    await prepareSchema()
    const room = env.TEST_ROOM.getByName('tenant-a')
    const created = await room.mutate('todos', 'insert', 'tenant-a', { id: 'todo-1', title: 'hello' }, 'mutation-1') as { id: string }
    expect(created.id).toBe('todo-1')
    const retried = await room.mutate('todos', 'insert', 'tenant-a', { id: 'todo-1', title: 'hello' }, 'mutation-1') as { id: string }
    expect(retried.id).toBe('todo-1')

    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM framework_todos WHERE id = ?').bind('todo-1').first<{ count: number }>()
    expect(count?.count).toBe(1)
  })

  it('does not write when real middleware short-circuits the terminal operation', async () => {
    await prepareSchema()
    const room = env.TEST_ROOM.getByName('tenant-a')
    await expect(room.mutate('todos', 'insert', 'tenant-a', { id: 'blocked-1', title: 'blocked' }, 'blocked-mutation')).resolves.toBeUndefined()
    expect(await env.DB.prepare('SELECT id FROM framework_todos WHERE id = ?').bind('blocked-1').first()).toBeNull()
  })

  it('rejects an unauthorized WebSocket before subscription', async () => {
    const response = await SELF.fetch('https://example.com/parties/main/tenant-a', {
      headers: { Upgrade: 'websocket', Authorization: 'Bearer tenant-b' },
    })
    expect(response.status).toBe(401)
    expect(response.webSocket).toBeNull()
  })

  it('delivers broadcasts after an authorized WebSocket upgrade', async () => {
    await prepareSchema()
    const response = await SELF.fetch('https://example.com/parties/main/tenant-a', {
      headers: { Upgrade: 'websocket', Authorization: 'Bearer tenant-a' },
    })
    expect(response.status).toBe(101)
    const socket = response.webSocket!
    socket.accept()
    const messages: string[] = []
    socket.addEventListener('message', event => { messages.push(String(event.data)) })
    await new Promise(resolve => setTimeout(resolve, 0))

    await env.TEST_ROOM.getByName('tenant-a').mutate(
      'todos', 'insert', 'tenant-a', { id: 'broadcast-1', title: 'broadcast' }, 'broadcast-mutation'
    )
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(messages.map(message => JSON.parse(message).type)).toContain('sync-init')
    expect(messages.some(message => {
      const event = JSON.parse(message)
      return event.type === 'broadcast' && event.payload.id === 'broadcast-1'
    })).toBe(true)
    socket.close()
  })

  it('leaves a detectable sequence gap when failure happens after reservation but before D1', async () => {
    await prepareSchema()
    const response = await SELF.fetch('https://example.com/parties/main/gap-tenant', {
      headers: { Upgrade: 'websocket', Authorization: 'Bearer gap-tenant' },
    })
    const socket = response.webSocket!
    socket.accept()
    const messages: string[] = []
    socket.addEventListener('message', event => { messages.push(String(event.data)) })
    await new Promise(resolve => setTimeout(resolve, 0))

    const room = env.TEST_ROOM.getByName('gap-tenant')
    await room.setFaultOnce('before-write')
    await expect(room.mutateCaptured(
      'gap-tenant', { id: 'never-written', title: 'fail' }, 'gap-mutation'
    )).resolves.toMatchObject({ ok: false, message: 'Injected failure before D1 write' })
    expect(await env.DB.prepare('SELECT id FROM framework_todos WHERE id = ?').bind('never-written').first()).toBeNull()

    await room.mutate('todos', 'insert', 'gap-tenant', { id: 'after-gap', title: 'ok' }, 'after-gap-mutation')
    await new Promise(resolve => setTimeout(resolve, 0))
    const event = messages.map(message => JSON.parse(message)).find(message => message.payload?.id === 'after-gap')
    expect(event.broadcastId).toBe(2)
    socket.close()
  })

  it('recovers a D1 commit followed by receipt failure without duplicating the row', async () => {
    await prepareSchema()
    const room = env.TEST_ROOM.getByName('receipt-tenant')
    await room.setFaultOnce('receipt')
    const payload = { id: 'receipt-recovery', title: 'committed' }

    await expect(room.mutateCaptured('receipt-tenant', payload, 'receipt-failure')).resolves.toMatchObject({
      ok: false,
      message: 'Mutation committed; retry with the same mutation ID to recover',
    })
    await expect(room.mutate('todos', 'insert', 'receipt-tenant', payload, 'receipt-failure')).resolves.toMatchObject({ id: 'receipt-recovery' })

    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM framework_todos WHERE id = ?')
      .bind('receipt-recovery').first<{ count: number }>()
    expect(count?.count).toBe(1)
  })

  it('retries a partially committed bulk insert without duplicating earlier batches', async () => {
    await prepareSchema()
    const syncId = 'bulk-retry-tenant'
    const room = env.TEST_ROOM.getByName(syncId)
    const payload = Array.from({ length: 23 }, (_, index) => ({
      id: index === 22 ? 'cross-tenant-conflict' : `bulk-retry-${index}`,
      title: `item ${index}`,
    }))

    await env.DB.prepare(
      'INSERT INTO framework_todos (id, sync_id, title) VALUES (?, ?, ?)'
    ).bind('cross-tenant-conflict', 'another-tenant', 'private').run()

    const failed = await room.bulkInsertCaptured(syncId, payload, 'partial-bulk-mutation')
    expect(failed).toMatchObject({
      ok: false,
      message: expect.stringContaining('conflicts outside this sync boundary'),
    })
    const afterFailure = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM framework_todos WHERE sync_id = ?'
    ).bind(syncId).first<{ count: number }>()
    expect(afterFailure?.count).toBe(22)

    await env.DB.prepare('DELETE FROM framework_todos WHERE id = ?')
      .bind('cross-tenant-conflict').run()

    const retried = await room.bulkInsertCaptured(syncId, payload, 'partial-bulk-mutation')
    expect(retried).toMatchObject({ ok: true })
    if (!retried.ok) throw new Error(retried.message)
    expect(retried.result).toHaveLength(23)

    const afterRetry = await env.DB.prepare(
      'SELECT COUNT(*) AS count, COUNT(DISTINCT id) AS distinctCount FROM framework_todos WHERE sync_id = ?'
    ).bind(syncId).first<{ count: number; distinctCount: number }>()
    expect(afterRetry).toEqual({ count: 23, distinctCount: 23 })
  })

  it('rejects reuse of a mutation ID with a different payload', async () => {
    await prepareSchema()
    const room = env.TEST_ROOM.getByName('mutation-conflict-tenant')

    await expect(room.mutateCaptured(
      'mutation-conflict-tenant',
      { id: 'mutation-conflict-a', title: 'first' },
      'reused-mutation-id',
    )).resolves.toMatchObject({ ok: true })

    await expect(room.mutateCaptured(
      'mutation-conflict-tenant',
      { id: 'mutation-conflict-b', title: 'different' },
      'reused-mutation-id',
    )).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('Mutation ID was already used with a different request'),
    })

    const rows = await env.DB.prepare(
      'SELECT id FROM framework_todos WHERE sync_id = ? ORDER BY id'
    ).bind('mutation-conflict-tenant').all<{ id: string }>()
    expect(rows.results).toEqual([{ id: 'mutation-conflict-a' }])
  })

  it('returns conflict semantics without exposing a cross-tenant entity', async () => {
    await prepareSchema()
    await env.DB.prepare(
      'INSERT INTO framework_todos (id, sync_id, title) VALUES (?, ?, ?)'
    ).bind('cross-tenant-single-id', 'private-tenant', 'private').run()
    const room = env.TEST_ROOM.getByName('conflict-attacker')

    await expect(room.mutateCaptured(
      'conflict-attacker',
      { id: 'cross-tenant-single-id', title: 'overwrite attempt' },
      'cross-tenant-single-mutation',
    )).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('[STATUS:409]'),
    })

    expect(await env.DB.prepare(
      'SELECT sync_id AS syncId, title FROM framework_todos WHERE id = ?'
    ).bind('cross-tenant-single-id').first()).toEqual({ syncId: 'private-tenant', title: 'private' })
  })

  it('does not update or delete an entity through a different scope', async () => {
    await prepareSchema()
    const syncId = 'scope-isolation-tenant'
    const room = env.TEST_ROOM.getByName(syncId)
    await room.mutate(
      'todos', 'insert', syncId,
      { id: 'scope-isolated', title: 'original', scope: 'scope-a' },
      'scope-isolation-insert', 'scope-a',
    )

    await expect(room.scopedMutationCaptured(
      'update', syncId,
      { id: 'scope-isolated', data: { title: 'forbidden update' } },
      'wrong-scope-update', 'scope-b',
    )).resolves.toMatchObject({ ok: false, message: expect.stringContaining('[STATUS:404]') })

    await expect(room.scopedMutationCaptured(
      'delete', syncId,
      { id: 'scope-isolated' },
      'wrong-scope-delete', 'scope-b',
    )).resolves.toMatchObject({ ok: false, message: expect.stringContaining('[STATUS:404]') })

    expect(await env.DB.prepare(
      'SELECT title, scope FROM framework_todos WHERE id = ?'
    ).bind('scope-isolated').first()).toEqual({ title: 'original', scope: 'scope-a' })
  })

  it('does not update or delete an entity through another syncId', async () => {
    await prepareSchema()
    const ownerRoom = env.TEST_ROOM.getByName('tenant-owner')
    const attackerRoom = env.TEST_ROOM.getByName('tenant-attacker')
    await ownerRoom.mutate(
      'todos', 'insert', 'tenant-owner',
      { id: 'tenant-isolated', title: 'private' },
      'tenant-isolation-insert',
    )

    await expect(attackerRoom.scopedMutationCaptured(
      'update', 'tenant-attacker',
      { id: 'tenant-isolated', data: { title: 'forbidden update' } },
      'cross-tenant-update',
    )).resolves.toMatchObject({ ok: false, message: expect.stringContaining('[STATUS:404]') })

    await expect(attackerRoom.scopedMutationCaptured(
      'delete', 'tenant-attacker',
      { id: 'tenant-isolated' },
      'cross-tenant-delete',
    )).resolves.toMatchObject({ ok: false, message: expect.stringContaining('[STATUS:404]') })

    expect(await env.DB.prepare(
      'SELECT sync_id AS syncId, title FROM framework_todos WHERE id = ?'
    ).bind('tenant-isolated').first()).toEqual({ syncId: 'tenant-owner', title: 'private' })
  })

  it('preserves counters, receipts, and a hibernated WebSocket across DO eviction', async () => {
    await prepareSchema()
    const syncId = 'eviction-tenant'
    const response = await SELF.fetch(`https://example.com/parties/main/${syncId}`, {
      headers: { Upgrade: 'websocket', Authorization: `Bearer ${syncId}` },
    })
    const socket = response.webSocket!
    socket.accept()
    const messages: string[] = []
    socket.addEventListener('message', event => { messages.push(String(event.data)) })
    await new Promise(resolve => setTimeout(resolve, 0))

    const room = env.TEST_ROOM.getByName(syncId)
    const firstPayload = { id: 'before-eviction', title: 'before' }
    await room.mutate('todos', 'insert', syncId, firstPayload, 'before-eviction-mutation')
    await new Promise(resolve => setTimeout(resolve, 0))

    await evictDurableObject(room)

    await room.mutate(
      'todos', 'insert', syncId,
      { id: 'after-eviction', title: 'after' },
      'after-eviction-mutation',
    )
    await room.mutate('todos', 'insert', syncId, firstPayload, 'before-eviction-mutation')
    await new Promise(resolve => setTimeout(resolve, 0))

    const broadcasts = messages
      .map(message => JSON.parse(message))
      .filter(message => message.type === 'broadcast')
    expect(broadcasts.map(message => message.broadcastId)).toEqual([1, 2])
    expect(broadcasts.map(message => message.payload.id)).toEqual(['before-eviction', 'after-eviction'])

    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM framework_todos WHERE sync_id = ?'
    ).bind(syncId).first<{ count: number }>()
    expect(count?.count).toBe(2)
    socket.close()
  })

  it('republishes the stored event on retry after a broadcast failure', async () => {
    await prepareSchema()
    const response = await SELF.fetch('https://example.com/parties/main/broadcast-tenant', {
      headers: { Upgrade: 'websocket', Authorization: 'Bearer broadcast-tenant' },
    })
    const socket = response.webSocket!
    socket.accept()
    const messages: string[] = []
    socket.addEventListener('message', event => { messages.push(String(event.data)) })
    await new Promise(resolve => setTimeout(resolve, 0))

    const room = env.TEST_ROOM.getByName('broadcast-tenant')
    await room.setFaultOnce('broadcast')
    const payload = { id: 'broadcast-recovery', title: 'committed' }
    await expect(room.mutateCaptured('broadcast-tenant', payload, 'broadcast-failure')).resolves.toMatchObject({
      ok: false,
      message: 'Mutation committed; retry with the same mutation ID to recover',
    })
    expect(messages.some(message => JSON.parse(message).payload?.id === 'broadcast-recovery')).toBe(false)

    await room.mutate('todos', 'insert', 'broadcast-tenant', payload, 'broadcast-failure')
    await new Promise(resolve => setTimeout(resolve, 0))
    const recovered = messages.filter(message => JSON.parse(message).payload?.id === 'broadcast-recovery')
    expect(recovered).toHaveLength(1)
    expect(JSON.parse(recovered[0]).broadcastId).toBe(1)
    socket.close()
  })

  it('caps retained mutation receipts per room', async () => {
    await prepareSchema()
    const room = env.TEST_ROOM.getByName('retention-tenant')
    for (let index = 1; index <= 3; index++) {
      await room.mutate(
        'todos', 'insert', 'retention-tenant', { id: `retained-${index}`, title: `item ${index}` }, `retained-mutation-${index}`
      )
    }
    expect(await room.countReceipts()).toBe(2)
  })

  it('uses the collection ownerColumn in the per-user preset', async () => {
    await prepareSchema()
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS framework_owner_todos (id TEXT PRIMARY KEY, sync_id TEXT NOT NULL, created_by TEXT NOT NULL, title TEXT NOT NULL)`)
    const room = env.OWNER_ROOM.getByName('owner-user')

    await expect(room.insertCaptured(
      'owner-user',
      { id: 'wrong-owner', title: 'blocked', createdBy: 'another-user' },
      'wrong-owner-mutation',
      'owner-user',
    )).resolves.toMatchObject({ ok: false, message: expect.stringContaining('createdBy mismatch') })

    await expect(room.insertCaptured(
      'owner-user',
      { id: 'right-owner', title: 'allowed', createdBy: 'owner-user' },
      'right-owner-mutation',
      'owner-user',
    )).resolves.toMatchObject({ ok: true, result: { id: 'right-owner', createdBy: 'owner-user' } })

    expect(await env.DB.prepare('SELECT id FROM framework_owner_todos WHERE id = ?')
      .bind('wrong-owner').first()).toBeNull()
    expect(await env.DB.prepare('SELECT created_by AS createdBy FROM framework_owner_todos WHERE id = ?')
      .bind('right-owner').first()).toEqual({ createdBy: 'owner-user' })
  })
})
