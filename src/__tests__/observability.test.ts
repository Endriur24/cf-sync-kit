import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureObservability,
  emitObservabilityEvent,
  type ObservabilityEvent,
} from '../shared/observability'

describe('observability', () => {
  let restore: (() => void) | undefined

  afterEach(() => {
    restore?.()
    restore = undefined
    vi.restoreAllMocks()
  })

  it('delivers a structured event to the configured central sink', () => {
    const events: ObservabilityEvent[] = []
    restore = configureObservability({ sink: event => events.push({ ...event }) })

    emitObservabilityEvent({
      level: 'info',
      event: 'mutation.completed',
      component: 'durable-object',
      collection: 'todos',
      action: 'insert',
      syncId: 'tenant-a',
      mutationId: 'mutation-a',
      broadcastId: 3,
      durationMs: 12,
      outcome: 'success',
    })

    expect(events).toEqual([expect.objectContaining({
      schemaVersion: 1,
      timestamp: expect.any(String),
      event: 'mutation.completed',
      collection: 'todos',
      broadcastId: 3,
      durationMs: 12,
    })])
    expect(events[0]).not.toHaveProperty('payload')
  })

  it('never lets a failing sink interrupt framework work', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    restore = configureObservability({ sink: () => { throw new Error('collector unavailable') } })

    expect(() => emitObservabilityEvent({
      level: 'error',
      event: 'mutation.failed',
      component: 'durable-object',
      status: 500,
      outcome: 'failure',
    })).not.toThrow()
    expect(console.error).toHaveBeenCalledWith(
      '[cf-sync-kit] Observability sink failed',
      'collector unavailable',
    )
  })
})
