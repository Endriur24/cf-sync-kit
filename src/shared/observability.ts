import type { ActionType } from './types'

export type ObservabilityLevel = 'debug' | 'info' | 'warn' | 'error'
export type ObservabilityStage = 'queue' | 'sequence' | 'd1' | 'receipt' | 'broadcast' | 'recovery'

export type ObservabilityEventName =
  | 'mutation.queue.started'
  | 'mutation.sequence.reserved'
  | 'mutation.d1.completed'
  | 'mutation.completed'
  | 'mutation.failed'
  | 'mutation.receipt.replayed'
  | 'mutation.broadcast.retry'
  | 'mutation.broadcast.failed'
  | 'sync.gap.detected'
  | 'sync.gap.recovered'

export interface ObservabilityEvent {
  schemaVersion: 1
  timestamp: string
  level: ObservabilityLevel
  event: ObservabilityEventName
  component: 'durable-object' | 'client'
  collection?: string
  action?: ActionType
  syncId?: string
  mutationId?: string
  broadcastId?: number
  durationMs?: number
  queueWaitMs?: number
  status?: number
  outcome?: 'success' | 'failure' | 'replayed'
  stage?: ObservabilityStage
}

export type ObservabilitySink = (event: Readonly<ObservabilityEvent>) => void

export interface ObservabilityOptions {
  /** Receives every structured framework event. Must not throw or perform blocking I/O. */
  sink?: ObservabilitySink
  /** Also emit structured objects through console for Workers Logs. @default false */
  console?: boolean
}

let activeOptions: ObservabilityOptions = {}

/**
 * Configures the observability sink for the current Worker/browser isolate.
 * Call once during application initialization. Returns a restore function for tests.
 */
export function configureObservability(options: ObservabilityOptions = {}): () => void {
  const previous = activeOptions
  activeOptions = { ...options }
  return () => { activeOptions = previous }
}

/** @internal */
export function emitObservabilityEvent(
  event: Omit<ObservabilityEvent, 'schemaVersion' | 'timestamp'> & { timestamp?: string },
): void {
  const structured: ObservabilityEvent = {
    ...event,
    schemaVersion: 1,
    timestamp: event.timestamp ?? new Date().toISOString(),
  }

  try {
    activeOptions.sink?.(structured)
  } catch (error) {
    console.error('[cf-sync-kit] Observability sink failed', error instanceof Error ? error.message : String(error))
  }

  if (activeOptions.console) {
    const method = structured.level === 'error'
      ? console.error
      : structured.level === 'warn'
        ? console.warn
        : console.log
    method(structured)
  }
}
