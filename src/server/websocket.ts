import { HTTPException } from 'hono/http-exception'
import type { DurableObjectBase } from './DurableObjectBase'

export const TRUSTED_WEBSOCKET_USER_HEADER = 'x-cf-sync-user-id'

export interface WebSocketAuthorizationContext {
  request: Request
  syncId: string
  party: string
}

export type WebSocketAuthorizer = (
  context: WebSocketAuthorizationContext
) => string | { userId?: string } | Response | void | Promise<string | { userId?: string } | Response | void>

export type WebSocketHandlerOptions = {
  /** URL prefix used by PartySocket. @default '/parties' */
  prefix?: string
  /** Restrict connections to one PartySocket party/namespace. */
  party?: string
} & (
  | { authorize: WebSocketAuthorizer; public?: never }
  | { public: true; authorize?: never }
)

/**
 * Routes PartySocket upgrades to a sync room. Callers must explicitly choose
 * public access or provide an authorizer.
 */
export function createWebSocketHandler<T extends DurableObjectBase>(
  namespace: DurableObjectNamespace<T>,
  options: WebSocketHandlerOptions
) {
  const prefix = `/${(options.prefix ?? '/parties').replace(/^\/+|\/+$/g, '')}`

  return async (request: Request): Promise<Response> => {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 })
    }

    const url = new URL(request.url)
    const match = url.pathname.match(new RegExp(`^${escapeRegExp(prefix)}/([^/]+)/([^/]+)/?$`))
    if (!match) return new Response('WebSocket route not found', { status: 404 })

    const party = decodeURIComponent(match[1])
    const syncId = decodeURIComponent(match[2])
    if (options.party && party !== options.party) return new Response('WebSocket party not found', { status: 404 })

    const headers = new Headers(request.headers)
    headers.delete(TRUSTED_WEBSOCKET_USER_HEADER)

    if (typeof options.authorize === 'function') {
      const authorization = await options.authorize({ request, syncId, party })
      if (authorization instanceof Response) return authorization
      const userId = typeof authorization === 'string' ? authorization : authorization?.userId
      if (userId) headers.set(TRUSTED_WEBSOCKET_USER_HEADER, userId)
    }

    headers.set('x-partykit-namespace', party)
    headers.set('x-partykit-room', syncId)
    const room = namespace.get(namespace.idFromName(syncId))
    return room.fetch(new Request(request, { headers }))
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Creates an authorizer for rooms whose syncId must equal the user ID. */
export function requireWebSocketUser(
  getUserId: (request: Request) => string | undefined | Promise<string | undefined>
): WebSocketAuthorizer {
  return async ({ request, syncId }) => {
    const userId = await getUserId(request)
    if (!userId) throw new HTTPException(401, { message: 'Unauthorized WebSocket connection' })
    if (userId !== syncId) throw new HTTPException(403, { message: 'Forbidden WebSocket room' })
    return userId
  }
}
