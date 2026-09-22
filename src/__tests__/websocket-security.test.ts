import { describe, expect, it, vi } from 'vitest'
import { createWebSocketHandler, TRUSTED_WEBSOCKET_USER_HEADER } from '../server/websocket'

function upgradeRequest(headers: Record<string, string> = {}) {
  return new Request('https://example.com/parties/todos/tenant-a', {
    headers: { Upgrade: 'websocket', ...headers },
  })
}

describe('createWebSocketHandler security boundary', () => {
  it('rejects non-upgrade requests without touching the Durable Object', async () => {
    const fetch = vi.fn()
    const namespace = {
      idFromName: vi.fn(),
      get: vi.fn(() => ({ fetch })),
    } as any

    const response = await createWebSocketHandler(namespace, { public: true })(
      new Request('https://example.com/parties/todos/tenant-a')
    )

    expect(response.status).toBe(426)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('can reject before resolving or billing a Durable Object room', async () => {
    const namespace = { idFromName: vi.fn(), get: vi.fn() } as any
    const response = await createWebSocketHandler(namespace, {
      authorize: () => new Response('Forbidden', { status: 403 }),
    })(upgradeRequest())

    expect(response.status).toBe(403)
    expect(namespace.idFromName).not.toHaveBeenCalled()
    expect(namespace.get).not.toHaveBeenCalled()
  })

  it('replaces a spoofed internal identity with the verified user', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.headers.get(TRUSTED_WEBSOCKET_USER_HEADER)).toBe('verified-user')
      expect(request.headers.get('x-partykit-room')).toBe('tenant-a')
      return new Response(null, { status: 204 })
    })
    const namespace = {
      idFromName: vi.fn(() => ({ id: 'tenant-a' })),
      get: vi.fn(() => ({ fetch })),
    } as any

    const response = await createWebSocketHandler(namespace, {
      party: 'todos',
      authorize: () => 'verified-user',
    })(upgradeRequest({ [TRUSTED_WEBSOCKET_USER_HEADER]: 'attacker' }))

    expect(response.status).toBe(204)
    expect(fetch).toHaveBeenCalledOnce()
  })
})
