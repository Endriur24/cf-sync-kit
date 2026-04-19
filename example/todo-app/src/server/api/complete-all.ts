import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { drizzle } from 'drizzle-orm/d1'
import { todosTable } from '../../../shared/schema'
import { getRoom } from '../do'

const completeAll = new Hono<{ Bindings: Bindings }>()
  .post('/', async (c) => {
    try {
      const db = drizzle(c.env.TODOS_DB)

      const updatedTodos = await db.update(todosTable)
        .set({ completed: true, updatedAt: new Date() })
        .returning()

      const room = getRoom(c.env)

      if (updatedTodos.length > 0) {
        await room.broadcastSyncEvent('todos', 'bulk-update', updatedTodos)
      }

      return c.json({
        success: true,
        updatedTodos
      })
    } catch (error) {
      console.error('complete-all failed:', error)
      if (error instanceof HTTPException) throw error
      throw new HTTPException(500, { message: 'Failed to complete all todos' })
    }
  })

export default completeAll
