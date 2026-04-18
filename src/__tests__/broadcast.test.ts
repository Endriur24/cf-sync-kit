import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BroadcastSystem } from '../server/BroadcastSystem'

function createMockStorage() {
  const data = new Map<string, unknown>()
  return {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => {
      return data.get(key) as T | undefined
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value)
    }),
    list: vi.fn(async (options?: { prefix?: string }) => {
      const results = new Map<string, unknown>()
      const prefix = options?.prefix ?? ''
      for (const [key, value] of data) {
        if (key.startsWith(prefix)) {
          results.set(key, value)
        }
      }
      return results
    }),
    deleteAll: vi.fn(async () => {
      data.clear()
    }),
    _data: data,
  }
}

type MockStorage = ReturnType<typeof createMockStorage>

describe('BroadcastSystem', () => {
  let storage: MockStorage
  let system: BroadcastSystem

  beforeEach(() => {
    storage = createMockStorage()
    system = new BroadcastSystem(storage as unknown as DurableObjectStorage)
  })

  describe('getNextId', () => {
    it('should return incrementing IDs', async () => {
      const id1 = await system.getNextId('todos')
      const id2 = await system.getNextId('todos')

      expect(id1).toBe(1)
      expect(id2).toBe(2)
    })

    it('should track counters per collection independently', async () => {
      const todos1 = await system.getNextId('todos')
      const notes1 = await system.getNextId('notes')
      const todos2 = await system.getNextId('todos')

      expect(todos1).toBe(1)
      expect(notes1).toBe(1)
      expect(todos2).toBe(2)
    })

    it('should use in-memory cache after initialization', async () => {
      await system.getNextId('todos')
      await system.getNextId('todos')

      expect(storage.list).toHaveBeenCalledTimes(1)
      expect(storage.get).not.toHaveBeenCalled()
    })

    it('should persist counter to storage on each call', async () => {
      await system.getNextId('todos')

      expect(storage.put).toHaveBeenCalledWith('broadcast_todos', 1)
    })

    it('should not update in-memory counter when storage.put fails', async () => {
      // First successful call to initialize
      await system.getNextId('todos')
      expect(await system.getCounter('todos')).toBe(1)

      // Make storage.put fail
      storage.put.mockRejectedValueOnce(new Error('Storage write failed'))

      await expect(system.getNextId('todos')).rejects.toThrow('Storage write failed')

      // In-memory counter should still be 1 (not 2)
      expect(await system.getCounter('todos')).toBe(1)
    })

    it('should continue from correct value after failed put', async () => {
      await system.getNextId('todos') // → 1
      expect(await system.getCounter('todos')).toBe(1)

      // Fail the next put
      storage.put.mockRejectedValueOnce(new Error('Storage write failed'))
      await expect(system.getNextId('todos')).rejects.toThrow('Storage write failed')

      // Counter should still be 1
      expect(await system.getCounter('todos')).toBe(1)

      // Next successful call should produce 2 (not 3)
      const nextId = await system.getNextId('todos')
      expect(nextId).toBe(2)
      expect(await system.getCounter('todos')).toBe(2)
    })
  })

  describe('getCounter', () => {
    it('should return current counter value', async () => {
      await system.getNextId('todos')
      const counter = await system.getCounter('todos')
      expect(counter).toBe(1)
    })

    it('should return 0 for uninitialized collection', async () => {
      const counter = await system.getCounter('nonexistent')
      expect(counter).toBe(0)
    })
  })

  describe('getAllCounters', () => {
    it('should return all counters', async () => {
      await system.getNextId('todos')
      await system.getNextId('notes')
      await system.getNextId('todos')

      const counters = await system.getAllCounters()
      expect(counters).toEqual({
        todos: 2,
        notes: 1,
      })
    })

    it('should initialize from storage on first call', async () => {
      storage._data.set('broadcast_todos', 5)
      storage._data.set('broadcast_notes', 3)

      const counters = await system.getAllCounters()
      expect(counters).toEqual({
        todos: 5,
        notes: 3,
      })
    })
  })

  describe('setCounter', () => {
    it('should set counter value in memory', async () => {
      system.setCounter('todos', 100)
      const counter = await system.getCounter('todos')
      expect(counter).toBe(100)
    })
  })

  describe('resetCounter', () => {
    it('should reset counter to zero', async () => {
      await system.getNextId('todos')
      await system.getNextId('todos')
      await system.getNextId('todos')

      const before = await system.getCounter('todos')
      expect(before).toBe(3)

      await system.resetCounter('todos')

      const after = await system.getCounter('todos')
      expect(after).toBe(0)
    })

    it('should persist reset to storage', async () => {
      await system.getNextId('todos')
      await system.resetCounter('todos')

      expect(storage.put).toHaveBeenCalledWith('broadcast_todos', 0)
    })

    it('should allow incrementing after reset', async () => {
      await system.getNextId('todos')
      await system.getNextId('todos')
      await system.resetCounter('todos')

      const afterReset = await system.getNextId('todos')
      expect(afterReset).toBe(1)
    })

    it('should work for uninitialized collections', async () => {
      await system.resetCounter('new-collection')
      const counter = await system.getCounter('new-collection')
      expect(counter).toBe(0)
    })
  })
})
