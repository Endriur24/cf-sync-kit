import { log } from '../shared/logger'

/**
 * Manages broadcast sequence counters for Durable Objects.
 *
 * Keeps counters in memory to avoid repeated storage reads.
 * Persists to storage on every increment to ensure durability after hibernation.
 */
export class BroadcastSystem {
  private storage: DurableObjectStorage
  private counters = new Map<string, number>()
  private initialized = false

  constructor(storage: DurableObjectStorage) {
    this.storage = storage
  }

  /**
   * Ensures all counters are loaded from storage into memory.
   * This is called lazily on first access.
   */
  private async ensureInitialized() {
    if (this.initialized) return
    try {
      const entries = await this.storage.list<number>({ prefix: 'broadcast_' })
      for (const [key, value] of entries) {
        const collection = key.replace('broadcast_', '')
        this.counters.set(collection, value)
      }
    } catch (error) {
      log.error('BroadcastSystem: Failed to load counters from storage:', error)
      throw error
    }
    this.initialized = true
  }

  /**
   * Returns the next broadcast ID for a collection.
   * Increments the counter in memory and persists to storage immediately
   * to ensure consistency after hibernation.
   */
  async getNextId(collection: string): Promise<number> {
    await this.ensureInitialized()
    const current = this.counters.get(collection) ?? 0
    const next = current + 1
    try {
      await this.storage.put(`broadcast_${collection}`, next)
      // Only update memory after successful persist
      this.counters.set(collection, next)
    } catch (error) {
      log.error(`BroadcastSystem: Failed to persist counter for ${collection}:`, error)
      throw error
    }
    return next
  }

  /**
   * Returns the current counter value for a collection.
   */
  async getCounter(collection: string): Promise<number> {
    await this.ensureInitialized()
    return this.counters.get(collection) ?? 0
  }

  /**
   * Returns all counters. Loads from storage on first call, then uses cache.
   */
  async getAllCounters(): Promise<Record<string, number>> {
    await this.ensureInitialized()
    const counters: Record<string, number> = {}
    for (const [collection, value] of this.counters) {
      counters[collection] = value
    }
    return counters
  }

  /**
   * Sets a counter value in memory.
   */
  setCounter(collection: string, value: number) {
    this.counters.set(collection, value)
  }

  /**
   * Resets a counter to zero in both memory and storage.
   * Useful when recreating a Durable Object or after clearing collection data.
   * Clients with cached counters may detect a "negative gap" and refetch,
   * which is safe but may cause temporary additional load.
   */
  async resetCounter(collection: string) {
    await this.ensureInitialized()
    try {
      await this.storage.put(`broadcast_${collection}`, 0)
      // Only update memory after successful persist
      this.counters.set(collection, 0)
    } catch (error) {
      log.error(`BroadcastSystem: Failed to reset counter for ${collection}:`, error)
      throw error
    }
  }

}
