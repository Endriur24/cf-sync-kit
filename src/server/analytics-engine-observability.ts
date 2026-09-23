import type {
  ObservabilityEvent,
  ObservabilityEventName,
  ObservabilityLevel,
  ObservabilitySink,
} from '../shared/observability'

export interface AnalyticsEngineDataPoint {
  indexes?: (string | ArrayBuffer | null)[]
  blobs?: (string | ArrayBuffer | null)[]
  doubles?: number[]
}

export interface AnalyticsEngineDatasetBinding {
  writeDataPoint(dataPoint?: AnalyticsEngineDataPoint): void
}

export type AnalyticsEngineIdentifierKind = 'syncId' | 'mutationId'

export interface AnalyticsEngineObservabilityOptions {
  /** Sampling index. Keep it stable and non-sensitive. @default "cf-sync-kit" */
  index?: string | ((event: Readonly<ObservabilityEvent>) => string)
  /** Export only selected severity levels. */
  levels?: readonly ObservabilityLevel[]
  /** Export only selected event families. */
  events?: readonly ObservabilityEventName[]
  /** Additional event predicate evaluated after level and event filters. */
  include?: (event: Readonly<ObservabilityEvent>) => boolean
  /**
   * Opt-in identifier export. Return a hash or another non-sensitive value.
   * Without this callback, syncId and mutationId are written as empty strings.
   */
  transformIdentifier?: (
    value: string,
    kind: AnalyticsEngineIdentifierKind,
    event: Readonly<ObservabilityEvent>,
  ) => string
}

/** Fixed column order used by createAnalyticsEngineSink(). */
export const ANALYTICS_ENGINE_OBSERVABILITY_SCHEMA = {
  index: 'samplingKey',
  blobs: [
    'event',
    'component',
    'level',
    'stage',
    'collection',
    'action',
    'outcome',
    'syncId',
    'mutationId',
  ],
  doubles: [
    'schemaVersion',
    'durationMs',
    'queueWaitMs',
    'broadcastId',
    'status',
  ],
} as const

const DEFAULT_INDEX = 'cf-sync-kit'
const MAX_INDEX_BYTES = 96
const MAX_BLOB_BYTES = 1024

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  const encoded = encoder.encode(value)
  if (encoded.byteLength <= maxBytes) return value
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let length = maxBytes; length > 0; length -= 1) {
    try {
      return decoder.decode(encoded.slice(0, length))
    } catch {
      // Continue to the previous complete UTF-8 boundary.
    }
  }
  return ''
}

function optionalNumber(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 0 : value
}

/**
 * Creates a synchronous, best-effort sink for a Workers Analytics Engine binding.
 * Identifier fields are private by default and require an explicit transformer.
 */
export function createAnalyticsEngineSink(
  dataset: AnalyticsEngineDatasetBinding,
  options: AnalyticsEngineObservabilityOptions = {},
): ObservabilitySink {
  const levels = options.levels ? new Set(options.levels) : undefined
  const events = options.events ? new Set(options.events) : undefined

  return event => {
    if (levels && !levels.has(event.level)) return
    if (events && !events.has(event.event)) return
    if (options.include && !options.include(event)) return

    const index = typeof options.index === 'function'
      ? options.index(event)
      : options.index ?? DEFAULT_INDEX
    const transformIdentifier = options.transformIdentifier
    const syncId = event.syncId && transformIdentifier
      ? transformIdentifier(event.syncId, 'syncId', event)
      : ''
    const mutationId = event.mutationId && transformIdentifier
      ? transformIdentifier(event.mutationId, 'mutationId', event)
      : ''
    const blob = (value: string | undefined) => truncateUtf8(value ?? '', MAX_BLOB_BYTES)

    dataset.writeDataPoint({
      indexes: [truncateUtf8(index, MAX_INDEX_BYTES)],
      blobs: [
        blob(event.event),
        blob(event.component),
        blob(event.level),
        blob(event.stage),
        blob(event.collection),
        blob(event.action),
        blob(event.outcome),
        blob(syncId),
        blob(mutationId),
      ],
      doubles: [
        event.schemaVersion,
        optionalNumber(event.durationMs),
        optionalNumber(event.queueWaitMs),
        optionalNumber(event.broadcastId),
        optionalNumber(event.status),
      ],
    })
  }
}
