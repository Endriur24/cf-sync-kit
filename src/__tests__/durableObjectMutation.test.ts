import { describe, expect, it, vi } from 'vitest'
import { MutationQueue } from '../server/MutationQueue'

describe('DurableObjectBase mutation delivery', () => {
  it('serializes mutations in call order even when an earlier operation rejects', async () => {
    const queue = new MutationQueue()
    const order: string[] = []

    const first = queue.enqueue(async () => {
      order.push('first')
      throw new Error('expected')
    })
    const second = queue.enqueue(async () => {
      order.push('second')
      return 'ok'
    })

    await expect(first).rejects.toThrow('expected')
    await expect(second).resolves.toBe('ok')
    expect(order).toEqual(['first', 'second'])
  })

  it('does not start the next operation before the prior one resolves', async () => {
    const queue = new MutationQueue()
    let release!: () => void
    const first = queue.enqueue(() => new Promise<void>((resolve) => { release = resolve }))
    const second = vi.fn(async () => 'done')
    const pending = queue.enqueue(second)

    await Promise.resolve()
    expect(second).not.toHaveBeenCalled()
    release()
    await first
    await expect(pending).resolves.toBe('done')
  })
})
