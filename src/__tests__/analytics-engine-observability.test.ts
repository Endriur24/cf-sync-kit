import { describe, expect, it, vi } from 'vitest'
import {
  ANALYTICS_ENGINE_OBSERVABILITY_SCHEMA,
  createAnalyticsEngineSink,
  type AnalyticsEngineDataPoint,
} from '../server/analytics-engine-observability'
import type { ObservabilityEvent } from '../shared/observability'

const event: ObservabilityEvent = {
  schemaVersion: 1,
  timestamp: '2026-09-23T10:00:00.000Z',
  level: 'info',
  event: 'mutation.completed',
  component: 'durable-object',
  stage: 'broadcast',
  collection: 'todos',
  action: 'insert',
  outcome: 'success',
  syncId: 'tenant-secret',
  mutationId: 'mutation-secret',
  durationMs: 12,
  queueWaitMs: 3,
  broadcastId: 7,
  status: 201,
}

function binding() {
  return { writeDataPoint: vi.fn<(point?: AnalyticsEngineDataPoint) => void>() }
}

describe('createAnalyticsEngineSink', () => {
  it('writes the documented fixed schema while keeping identifiers private by default', () => {
    const dataset = binding()

    createAnalyticsEngineSink(dataset)(event)

    expect(ANALYTICS_ENGINE_OBSERVABILITY_SCHEMA.blobs[0]).toBe('event')
    expect(dataset.writeDataPoint).toHaveBeenCalledWith({
      indexes: ['cf-sync-kit'],
      blobs: [
        'mutation.completed',
        'durable-object',
        'info',
        'broadcast',
        'todos',
        'insert',
        'success',
        '',
        '',
      ],
      doubles: [1, 12, 3, 7, 201],
    })
  })

  it('supports a custom sampling index and explicit identifier transformation', () => {
    const dataset = binding()
    const transformIdentifier = vi.fn((value: string, kind: string) => `${kind}:${value.length}`)
    const sink = createAnalyticsEngineSink(dataset, {
      index: current => `tenant:${current.syncId?.length}`,
      transformIdentifier,
    })

    sink(event)

    expect(dataset.writeDataPoint.mock.calls[0][0]?.indexes).toEqual(['tenant:13'])
    expect(dataset.writeDataPoint.mock.calls[0][0]?.blobs?.slice(-2)).toEqual([
      'syncId:13',
      'mutationId:15',
    ])
    expect(transformIdentifier).toHaveBeenCalledTimes(2)
  })

  it('filters by level, event and predicate without writing rejected events', () => {
    const dataset = binding()
    const sink = createAnalyticsEngineSink(dataset, {
      levels: ['error'],
      events: ['mutation.failed'],
      include: current => current.status === 500,
    })

    sink(event)
    sink({ ...event, level: 'error', event: 'mutation.failed', status: 409 })
    sink({ ...event, level: 'error', event: 'mutation.failed', status: 500 })

    expect(dataset.writeDataPoint).toHaveBeenCalledTimes(1)
  })

  it('normalizes missing and non-finite numeric values', () => {
    const dataset = binding()

    createAnalyticsEngineSink(dataset)({
      ...event,
      durationMs: Number.NaN,
      queueWaitMs: undefined,
      broadcastId: Number.POSITIVE_INFINITY,
      status: undefined,
    })

    expect(dataset.writeDataPoint.mock.calls[0][0]?.doubles).toEqual([1, 0, 0, 0, 0])
  })

  it('truncates oversized indexes to the Analytics Engine byte limit', () => {
    const dataset = binding()

    createAnalyticsEngineSink(dataset, { index: `x${'😀'.repeat(30)}` })(event)

    const index = dataset.writeDataPoint.mock.calls[0][0]?.indexes?.[0]
    expect(new TextEncoder().encode(index as string).byteLength).toBeLessThanOrEqual(96)
    expect(index).not.toContain('�')
  })
})
