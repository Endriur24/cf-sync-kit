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

describe('Middleware execution order', () => {
  it('should execute middleware in onion model order', async () => {
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

  it('should execute middlewareBefore before middleware', async () => {
    const system = new MiddlewareSystem()
    const order: string[] = []

    const beforeMw = async (_ctx: MiddlewareContext, next: () => Promise<void>) => {
      order.push('before-start')
      await next()
      order.push('before-end')
    }

    const afterMw = async (_ctx: MiddlewareContext, next: () => Promise<void>) => {
      order.push('after-start')
      await next()
      order.push('after-end')
    }

    system.use(beforeMw)
    system.use(afterMw)

    await system.execute(createMockContext())

    expect(order).toEqual(['before-start', 'after-start', 'after-end', 'before-end'])
  })

  it('should handle empty middleware chain', async () => {
    const system = new MiddlewareSystem()
    await expect(system.execute(createMockContext())).resolves.toBeUndefined()
  })
})
