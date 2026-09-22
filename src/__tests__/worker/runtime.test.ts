import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('Workers runtime harness', () => {
  it('executes Durable Object RPC against a real isolated D1 binding', async () => {
    const room = env.TEST_ROOM.getByName('tenant-a')
    await expect(room.writeAndRead('greeting', 'hello')).resolves.toEqual({ value: 'hello' })

    const row = await env.DB.prepare(
      'SELECT value FROM worker_runtime_test WHERE key = ?'
    ).bind('greeting').first<{ value: string }>()
    expect(row).toEqual({ value: 'hello' })
  })
})
