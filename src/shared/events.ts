import { z } from 'zod'
import type { ActionType } from './types'

const ActionTypeSchema = z.enum(['insert', 'update', 'delete', 'bulk-insert', 'bulk-update', 'bulk-delete'])

/**
 * Zod discriminated union schema for WebSocket events.
 * Each event type has its own strict schema — missing required fields
 * will fail validation instead of silently being undefined.
 *
 * After parsing, TypeScript narrows the type automatically based on `type`.
 */
export const WsEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('broadcast'),
    collection: z.string(),
    action: ActionTypeSchema,
    payload: z.unknown(),
    broadcastId: z.number(),
    clientMutationId: z.string().optional(),
    scope: z.string().optional(),
  }),
  z.object({
    type: z.literal('sync-init'),
    counters: z.record(z.string(), z.number()),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
  }),
])

/**
 * Event broadcast to all connected clients after a mutation.
 * @template TCollection - Collection name type
 * @template TPayload - Payload type
 */
export type WsBroadcastEvent<TCollection extends string = string, TPayload = unknown> = {
  type: 'broadcast'
  collection: TCollection
  action: ActionType
  payload: TPayload
  broadcastId: number
  clientMutationId?: string
  scope?: string
}

/**
 * Initial sync event sent to clients on WebSocket connection.
 * Contains current broadcast counters for each collection.
 */
export type WsSyncInitEvent = {
  type: 'sync-init'
  counters: Record<string, number>
}

/**
 * Union type of all WebSocket events — inferred from WsEventSchema.
 * Automatically stays in sync with the Zod schema.
 */
export type WsEvent = z.infer<typeof WsEventSchema>


