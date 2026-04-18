import { describe, it, expect, vi } from 'vitest'
import {
  createAuthMiddleware,
  createCollectionFilterMiddleware,
  createLoggingMiddleware,
  requireOwner,
  createSyncAccessMiddleware,
  createCollectionAccessMiddleware,
} from '../server/middleware'
import type { MiddlewareContext } from '../server/MiddlewareSystem'

function createMockContext(overrides: Partial<MiddlewareContext> = {}): MiddlewareContext {
  return {
    collection: 'todos',
    action: 'insert',
    syncId: 'test-sync',
    payload: { title: 'Test' },
    ...overrides,
  }
}

describe('createAuthMiddleware', () => {
  it('should pass when user is authenticated', async () => {
    const middleware = createAuthMiddleware(() => 'user-123')
    const next = vi.fn()
    const ctx = createMockContext()

    await middleware(ctx, next)

    expect(ctx.userId).toBe('user-123')
    expect(next).toHaveBeenCalled()
  })

  it('should reject when user is not authenticated', async () => {
    const middleware = createAuthMiddleware(() => null)
    const next = vi.fn()

    await expect(middleware(createMockContext(), next)).rejects.toThrow('Unauthorized')
    expect(next).not.toHaveBeenCalled()
  })

  it('should support async auth functions', async () => {
    const middleware = createAuthMiddleware(async () => 'async-user')
    const next = vi.fn()
    const ctx = createMockContext()

    await middleware(ctx, next)

    expect(ctx.userId).toBe('async-user')
  })
})

describe('createCollectionFilterMiddleware', () => {
  it('should allow access to permitted collections', async () => {
    const middleware = createCollectionFilterMiddleware(['todos', 'notes'])
    const next = vi.fn()

    await middleware(createMockContext({ collection: 'todos' }), next)
    await middleware(createMockContext({ collection: 'notes' }), next)

    expect(next).toHaveBeenCalledTimes(2)
  })

  it('should reject access to unpermitted collections', async () => {
    const middleware = createCollectionFilterMiddleware(['todos'])
    const next = vi.fn()

    await expect(
      middleware(createMockContext({ collection: 'notes' }), next)
    ).rejects.toThrow("Collection 'notes' is not allowed")
  })
})

describe('createLoggingMiddleware', () => {
  it('should log mutation start and completion', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const middleware = createLoggingMiddleware()
    const next = vi.fn()

    await middleware(createMockContext(), next)

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('[Mutation]'),
      expect.anything()
    )
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('Completed'),
      expect.anything()
    )

    spy.mockRestore()
  })
})

describe('requireOwner', () => {
  it('should reject if no userId', async () => {
    const middleware = requireOwner()
    const next = vi.fn()

    await expect(
      middleware(createMockContext({ payload: { ownerId: 'user-1' } }), next)
    ).rejects.toThrow('Unauthorized')
    expect(next).not.toHaveBeenCalled()
  })

  describe('insert', () => {
    it('should allow insert when ownerId matches userId', async () => {
      const middleware = requireOwner()
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'insert',
        userId: 'user-1',
        payload: { ownerId: 'user-1', title: 'Test' },
      })

      await middleware(ctx, next)
      expect(next).toHaveBeenCalled()
    })

    it('should reject insert when ownerId does not match userId', async () => {
      const middleware = requireOwner()
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'insert',
        userId: 'user-1',
        payload: { ownerId: 'user-2', title: 'Test' },
      })

      await expect(middleware(ctx, next)).rejects.toThrow('ownerId mismatch')
      expect(next).not.toHaveBeenCalled()
    })

    it('should allow insert when ownerId is missing (backend injects it)', async () => {
      const middleware = requireOwner()
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'insert',
        userId: 'user-1',
        payload: { title: 'Test' },
      })

      await middleware(ctx, next)
      expect(next).toHaveBeenCalled()
    })
  })

  describe('update', () => {
    it('should pass through (ownership enforced by syncId isolation)', async () => {
      const middleware = requireOwner()
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'update',
        userId: 'user-1',
        payload: { id: '123', data: { ownerId: 'user-2', title: 'Updated' } },
      })

      await middleware(ctx, next)
      expect(next).toHaveBeenCalled()
    })
  })

  describe('delete', () => {
    it('should pass through (ownership enforced by syncId isolation)', async () => {
      const middleware = requireOwner()
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'delete',
        userId: 'user-1',
        payload: { id: '123' },
      })

      await middleware(ctx, next)
      expect(next).toHaveBeenCalled()
    })
  })
})

describe('createSyncAccessMiddleware', () => {
  it('should reject if no userId', async () => {
    const middleware = createSyncAccessMiddleware(() => {})
    const next = vi.fn()

    await expect(
      middleware(createMockContext(), next)
    ).rejects.toThrow('Unauthorized')
    expect(next).not.toHaveBeenCalled()
  })

  it('should allow when validate passes', async () => {
    const validate = vi.fn()
    const middleware = createSyncAccessMiddleware(validate)
    const next = vi.fn()
    const ctx = createMockContext({ userId: 'user-1', syncId: 'user:user-1' })

    await middleware(ctx, next)
    expect(validate).toHaveBeenCalledWith('user-1', 'user:user-1')
    expect(next).toHaveBeenCalled()
  })

  it('should reject when validate throws', async () => {
    const middleware = createSyncAccessMiddleware((userId, syncId) => {
      if (syncId !== `user:${userId}`) throw new Error('Forbidden')
    })
    const next = vi.fn()
    const ctx = createMockContext({ userId: 'user-1', syncId: 'user:user-2' })

    await expect(middleware(ctx, next)).rejects.toThrow('Forbidden')
    expect(next).not.toHaveBeenCalled()
  })
})

describe('requireOwner — bulk operations', () => {
  describe('bulk-insert', () => {
    it('should reject when any item has mismatched ownerId', async () => {
      const middleware = requireOwner()
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'bulk-insert',
        userId: 'user-1',
        payload: [
          { ownerId: 'user-1', title: 'OK' },
          { ownerId: 'user-2', title: 'Bad' },
        ],
      })

      await expect(middleware(ctx, next)).rejects.toThrow('ownerId mismatch in bulk-insert')
      expect(next).not.toHaveBeenCalled()
    })

    it('should allow when all items have correct ownerId', async () => {
      const middleware = requireOwner()
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'bulk-insert',
        userId: 'user-1',
        payload: [
          { ownerId: 'user-1', title: 'A' },
          { ownerId: 'user-1', title: 'B' },
        ],
      })

      await middleware(ctx, next)
      expect(next).toHaveBeenCalled()
    })

    it('should allow when items have no ownerId (backend injects)', async () => {
      const middleware = requireOwner()
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'bulk-insert',
        userId: 'user-1',
        payload: [
          { title: 'A' },
          { title: 'B' },
        ],
      })

      await middleware(ctx, next)
      expect(next).toHaveBeenCalled()
    })
  })

  describe('bulk-update with checkOnUpdateDelete', () => {
    it('should reject when ownerCheckQuery returns false for any item', async () => {
      const ownerCheckQuery = vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)

      const middleware = requireOwner({ checkOnUpdateDelete: true, ownerCheckQuery })
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'bulk-update',
        userId: 'user-1',
        payload: [
          { id: 'rec-1', data: { title: 'A' } },
          { id: 'rec-2', data: { title: 'B' } },
        ],
      })

      await expect(middleware(ctx, next)).rejects.toThrow('you do not own record rec-2')
      expect(next).not.toHaveBeenCalled()
    })

    it('should allow when ownerCheckQuery returns true for all items', async () => {
      const ownerCheckQuery = vi.fn().mockResolvedValue(true)
      const middleware = requireOwner({ checkOnUpdateDelete: true, ownerCheckQuery })
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'bulk-update',
        userId: 'user-1',
        payload: [
          { id: 'rec-1', data: { title: 'A' } },
          { id: 'rec-2', data: { title: 'B' } },
        ],
      })

      await middleware(ctx, next)
      expect(next).toHaveBeenCalled()
      expect(ownerCheckQuery).toHaveBeenCalledTimes(2)
    })

    it('should throw 500 when checkOnUpdateDelete is true but no ownerCheckQuery', async () => {
      const middleware = requireOwner({ checkOnUpdateDelete: true })
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'bulk-update',
        userId: 'user-1',
        payload: [{ id: 'rec-1', data: { title: 'A' } }],
      })

      await expect(middleware(ctx, next)).rejects.toThrow('Misconfiguration')
      expect(next).not.toHaveBeenCalled()
    })
  })

  describe('bulk-delete with checkOnUpdateDelete', () => {
    it('should reject when ownerCheckQuery returns false for any item', async () => {
      const ownerCheckQuery = vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)

      const middleware = requireOwner({ checkOnUpdateDelete: true, ownerCheckQuery })
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'bulk-delete',
        userId: 'user-1',
        payload: ['rec-1', 'rec-2'],
      })

      await expect(middleware(ctx, next)).rejects.toThrow('you do not own record rec-2')
      expect(next).not.toHaveBeenCalled()
    })

    it('should allow when ownerCheckQuery returns true for all items', async () => {
      const ownerCheckQuery = vi.fn().mockResolvedValue(true)
      const middleware = requireOwner({ checkOnUpdateDelete: true, ownerCheckQuery })
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'bulk-delete',
        userId: 'user-1',
        payload: ['rec-1', 'rec-2'],
      })

      await middleware(ctx, next)
      expect(next).toHaveBeenCalled()
      expect(ownerCheckQuery).toHaveBeenCalledTimes(2)
    })
  })

  describe('bulk-update/delete without checkOnUpdateDelete', () => {
    it('should pass through bulk-update without checks', async () => {
      const middleware = requireOwner()
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'bulk-update',
        userId: 'user-1',
        payload: [{ id: 'rec-1', data: { title: 'A' } }],
      })

      await middleware(ctx, next)
      expect(next).toHaveBeenCalled()
    })

    it('should pass through bulk-delete without checks', async () => {
      const middleware = requireOwner()
      const next = vi.fn()
      const ctx = createMockContext({
        action: 'bulk-delete',
        userId: 'user-1',
        payload: ['rec-1'],
      })

      await middleware(ctx, next)
      expect(next).toHaveBeenCalled()
    })
  })
})

describe('createCollectionAccessMiddleware — deny-by-default', () => {
  it('should deny when no rule for action and no wildcard', async () => {
    const middleware = createCollectionAccessMiddleware({
      todos: {
        insert: true,
        // 'delete' is not defined, no '*' wildcard
      },
    })
    const next = vi.fn()
    const ctx = createMockContext({ collection: 'todos', action: 'delete' })

    await expect(middleware(ctx, next)).rejects.toThrow('no access rule defined for delete')
    expect(next).not.toHaveBeenCalled()
  })

  it('should allow when wildcard * covers missing action', async () => {
    const middleware = createCollectionAccessMiddleware({
      todos: {
        insert: true,
        '*': true,
      },
    })
    const next = vi.fn()
    const ctx = createMockContext({ collection: 'todos', action: 'delete' })

    await middleware(ctx, next)
    expect(next).toHaveBeenCalled()
  })

  it('should deny when wildcard * is false', async () => {
    const middleware = createCollectionAccessMiddleware({
      todos: {
        insert: true,
        '*': false,
      },
    })
    const next = vi.fn()
    const ctx = createMockContext({ collection: 'todos', action: 'delete' })

    await expect(middleware(ctx, next)).rejects.toThrow('Forbidden: delete on collection "todos"')
    expect(next).not.toHaveBeenCalled()
  })

  it('should use specific action rule over wildcard', async () => {
    const middleware = createCollectionAccessMiddleware({
      todos: {
        delete: false,
        '*': true,
      },
    })
    const next = vi.fn()
    const ctx = createMockContext({ collection: 'todos', action: 'delete' })

    await expect(middleware(ctx, next)).rejects.toThrow('Forbidden: delete on collection "todos"')
    expect(next).not.toHaveBeenCalled()
  })

  it('should deny when collection has no rules and global wildcard has no matching action', async () => {
    const middleware = createCollectionAccessMiddleware({
      '*': {
        insert: true,
        // no 'delete' or '*' wildcard at action level
      },
    })
    const next = vi.fn()
    const ctx = createMockContext({ collection: 'notes', action: 'delete' })

    await expect(middleware(ctx, next)).rejects.toThrow('no access rule defined for delete')
    expect(next).not.toHaveBeenCalled()
  })

  it('should allow when collection falls through to global wildcard with matching action', async () => {
    const middleware = createCollectionAccessMiddleware({
      '*': {
        '*': true,
      },
    })
    const next = vi.fn()
    const ctx = createMockContext({ collection: 'anything', action: 'delete' })

    await middleware(ctx, next)
    expect(next).toHaveBeenCalled()
  })

  it('should deny when no rules for collection at all', async () => {
    const middleware = createCollectionAccessMiddleware({
      todos: {
        '*': true,
      },
    })
    const next = vi.fn()
    const ctx = createMockContext({ collection: 'notes', action: 'insert' })

    await expect(middleware(ctx, next)).rejects.toThrow('No access rules defined for collection "notes"')
    expect(next).not.toHaveBeenCalled()
  })
})
