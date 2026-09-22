/**
 * Serializes asynchronous mutations without retaining a rejected promise as the tail.
 * This is intentionally independent from Durable Object APIs so its ordering guarantee
 * can be tested in the regular Node test suite.
 */
export class MutationQueue {
  private tail: Promise<void> = Promise.resolve()

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}
