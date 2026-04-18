import { describe, it, expect, vi } from 'vitest'
import { MiddlewareSystem, type MiddlewareContext } from '../server/MiddlewareSystem'

function createMockContext(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    collection: 'test',
    action: 'insert',
    syncId: 'test-sync',
    payload: {},
    ...overrides,
  }
}

describe('MiddlewareSystem', () => {
  it('should execute middleware in order', async () => {
    const system = new MiddlewareSystem()
    const order: number[] = []

    system.use(async (_ctx, next) => {
      order.push(1)
      await next()
      order.push(4)
    })
    system.use(async (_ctx, next) => {
      order.push(2)
      await next()
      order.push(3)
    })

    await system.execute(createMockContext())
    expect(order).toEqual([1, 2, 3, 4])
  })

  it('should support chaining with use()', () => {
    const system = new MiddlewareSystem()
    const mw1: Parameters<typeof system.use>[0] = async (_ctx, next) => next()
    const mw2: Parameters<typeof system.use>[0] = async (_ctx, next) => next()

    const result = system.use(mw1).use(mw2)
    expect(result).toBe(system)
  })

  it('should allow middleware to reject by throwing', async () => {
    const system = new MiddlewareSystem()

    system.use(async () => {
      throw new Error('Unauthorized')
    })

    await expect(system.execute(createMockContext())).rejects.toThrow('Unauthorized')
  })

  it('should stop execution if next() is not called', async () => {
    const system = new MiddlewareSystem()
    const called = vi.fn()

    system.use(async () => {
      // Don't call next
    })
    system.use(async () => {
      called()
    })

    await system.execute(createMockContext())
    expect(called).not.toHaveBeenCalled()
  })

  it('should pass context to middleware', async () => {
    const system = new MiddlewareSystem()
    let receivedCtx: MiddlewareContext | undefined

    system.use(async (ctx, next) => {
      receivedCtx = ctx
      await next()
    })

    const ctx = createMockContext({ collection: 'todos', action: 'update' })
    await system.execute(ctx)

    expect(receivedCtx?.collection).toBe('todos')
    expect(receivedCtx?.action).toBe('update')
    expect(receivedCtx?.syncId).toBe('test-sync')
  })

  it('should allow middleware to modify context', async () => {
    const system = new MiddlewareSystem()
    let finalUserId: string | undefined

    system.use(async (ctx, next) => {
      ctx.userId = 'user-123'
      await next()
    })
    system.use(async (ctx, next) => {
      finalUserId = ctx.userId
      await next()
    })

    await system.execute(createMockContext())
    expect(finalUserId).toBe('user-123')
  })

  it('should clear all middleware', async () => {
    const system = new MiddlewareSystem()
    const called = vi.fn()

    system.use(async () => {
      called()
    })
    system.clear()

    await system.execute(createMockContext())
    expect(called).not.toHaveBeenCalled()
  })

  it('should handle empty middleware chain', async () => {
    const system = new MiddlewareSystem()
    await expect(system.execute(createMockContext())).resolves.toBeUndefined()
  })
})
