import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('Workers runtime harness', () => {
  async function prepareSchema() {
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS framework_todos (id TEXT PRIMARY KEY, sync_id TEXT NOT NULL, title TEXT NOT NULL, scope TEXT)`)
  }

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
})
