import { describe, it, expect, vi } from 'vitest'
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import { createSyncApi } from '../server/createSyncApi'
import type { RoomMutator } from '../server/createCollectionRouter'
import { DEFAULT_SYNC_ID } from '../shared/types'

const todosTable = sqliteTable('todos', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  completed: integer('completed', { mode: 'boolean' }).notNull().default(false),
})

const insertSchema = z.object({ title: z.string(), completed: z.boolean().optional() })
const updateSchema = z.object({ title: z.string().optional(), completed: z.boolean().optional() })
const selectSchema = z.object({ id: z.string(), title: z.string(), completed: z.boolean() })

const mockEnv = {} as Bindings

function createMockRoom(): RoomMutator {
  return {
    mutate: vi.fn().mockResolvedValue({ id: '1', title: 'Test' }),
    findAll: vi.fn().mockResolvedValue([{ id: '1', title: 'Test' }]),
  }
}

describe('createSyncApi route structure', () => {
  it('GET /:syncId/:collection routes through Durable Object when consistent=true', async () => {
    const room = createMockRoom()
    const getRoom = vi.fn().mockReturnValue(room)
    const api = createSyncApi(
      { todos: { table: todosTable, insertSchema, updateSchema, selectSchema } },
      getRoom,
      { consistentReads: true }
    )

    const res = await api.request('/tenant/todos?consistent=true', {}, mockEnv)
    expect(res.status).toBe(200)
    expect(getRoom).toHaveBeenCalledWith(mockEnv, 'tenant')
    expect(room.findAll).toHaveBeenCalledWith('todos', 'tenant')
  })

  it('POST /:syncId/:collection calls mutate insert', async () => {
    const room = createMockRoom()
    const getRoom = vi.fn().mockReturnValue(room)
    const api = createSyncApi(
      { todos: { table: todosTable, insertSchema, updateSchema, selectSchema } },
      getRoom
    )

    const res = await api.request('/tenant/todos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New' }),
    }, mockEnv)
    expect(res.status).toBe(200)
    expect(getRoom).toHaveBeenCalledWith(mockEnv, 'tenant')
    expect(room.mutate).toHaveBeenCalledWith('todos', 'insert', 'tenant', expect.objectContaining({ title: 'New' }), undefined, undefined, undefined)
  })

  it('PUT /:syncId/:collection/:id calls mutate update', async () => {
    const room = createMockRoom()
    const getRoom = vi.fn().mockReturnValue(room)
    const api = createSyncApi(
      { todos: { table: todosTable, insertSchema, updateSchema, selectSchema } },
      getRoom
    )

    const res = await api.request('/tenant/todos/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Updated' }),
    }, mockEnv)
    expect(res.status).toBe(200)
    expect(getRoom).toHaveBeenCalledWith(mockEnv, 'tenant')
    expect(room.mutate).toHaveBeenCalledWith('todos', 'update', 'tenant', expect.objectContaining({ id: '1', data: { title: 'Updated' } }), undefined, undefined, undefined)
  })

  it('DELETE /:syncId/:collection/:id calls mutate delete', async () => {
    const room = createMockRoom()
    const getRoom = vi.fn().mockReturnValue(room)
    const api = createSyncApi(
      { todos: { table: todosTable, insertSchema, updateSchema, selectSchema } },
      getRoom
    )

    const res = await api.request('/tenant/todos/1?_clientMutationId=abc', {
      method: 'DELETE',
    }, mockEnv)
    expect(res.status).toBe(200)
    expect(getRoom).toHaveBeenCalledWith(mockEnv, 'tenant')
    expect(room.mutate).toHaveBeenCalledWith('todos', 'delete', 'tenant', { id: '1' }, 'abc', undefined, undefined)
  })

  it('POST /:syncId/:collection/bulk calls mutate bulk-insert', async () => {
    const room = createMockRoom()
    const getRoom = vi.fn().mockReturnValue(room)
    const api = createSyncApi(
      { todos: { table: todosTable, insertSchema, updateSchema, selectSchema } },
      getRoom
    )

    const res = await api.request('/tenant/todos/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ title: 'A' }, { title: 'B' }] }),
    }, mockEnv)
    expect(res.status).toBe(200)
    expect(getRoom).toHaveBeenCalledWith(mockEnv, 'tenant')
    expect(room.mutate).toHaveBeenCalledWith('todos', 'bulk-insert', 'tenant', expect.any(Array), undefined, undefined, undefined)
  })

  it('PUT /:syncId/:collection/bulk calls mutate bulk-update', async () => {
    const room = createMockRoom()
    const getRoom = vi.fn().mockReturnValue(room)
    const api = createSyncApi(
      { todos: { table: todosTable, insertSchema, updateSchema, selectSchema } },
      getRoom
    )

    const res = await api.request('/tenant/todos/bulk', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ id: '1', data: { title: 'A' } }] }),
    }, mockEnv)
    expect(res.status).toBe(200)
    expect(getRoom).toHaveBeenCalledWith(mockEnv, 'tenant')
    expect(room.mutate).toHaveBeenCalledWith('todos', 'bulk-update', 'tenant', expect.any(Array), undefined, undefined, undefined)
  })

  it('DELETE /:syncId/:collection/bulk calls mutate bulk-delete', async () => {
    const room = createMockRoom()
    const getRoom = vi.fn().mockReturnValue(room)
    const api = createSyncApi(
      { todos: { table: todosTable, insertSchema, updateSchema, selectSchema } },
      getRoom
    )

    const res = await api.request('/tenant/todos/bulk', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['1', '2'] }),
    }, mockEnv)
    expect(res.status).toBe(200)
    expect(getRoom).toHaveBeenCalledWith(mockEnv, 'tenant')
    expect(room.mutate).toHaveBeenCalledWith('todos', 'bulk-delete', 'tenant', ['1', '2'], undefined, undefined, undefined)
  })

  it('returns 404 for unknown collection', async () => {
    const room = createMockRoom()
    const getRoom = vi.fn().mockReturnValue(room)
    const api = createSyncApi(
      { todos: { table: todosTable, insertSchema, updateSchema, selectSchema } },
      getRoom
    )

    const res = await api.request('/tenant/unknown', {}, mockEnv)
    expect(res.status).toBe(404)
    expect(getRoom).not.toHaveBeenCalled()
  })

  it('single-tenant uses DEFAULT_SYNC_ID from path', async () => {
    const room = createMockRoom()
    const getRoom = vi.fn().mockReturnValue(room)
    const api = createSyncApi(
      { todos: { table: todosTable, insertSchema, updateSchema, selectSchema, singleTenant: true } },
      getRoom,
      { consistentReads: true }
    )

    const res = await api.request(`/${DEFAULT_SYNC_ID}/todos?consistent=true`, {}, mockEnv)
    expect(res.status).toBe(200)
    expect(getRoom).toHaveBeenCalledWith(mockEnv, DEFAULT_SYNC_ID)
    expect(room.findAll).toHaveBeenCalledWith('todos', DEFAULT_SYNC_ID)
  })
})
