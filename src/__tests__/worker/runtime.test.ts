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
})
