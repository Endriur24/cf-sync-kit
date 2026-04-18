import type { ActionType } from '../shared/types'
import type { CustomAccess } from './types'

/**
 * Context passed to middleware functions during mutation execution.
 */
export interface MiddlewareContext {
  /** Collection being mutated */
  collection: string
  /** Type of mutation action */
  action: ActionType
  /** Sync ID for multi-tenant isolation */
  syncId: string
  /** Mutation payload (varies by action) */
  payload: unknown
  /** Optional user ID, can be set by auth middleware */
  userId?: string
  /** Cloudflare Worker bindings (contains D1 database, etc.) */
  env?: Bindings
  /** 
   * Custom context injected by your auth/permission middleware.
   * Example: { role: 'owner', projectAccess: {...}, teamAccess: {...} }
   * 
   * Extend via module augmentation for type safety:
   * declare module 'cf-sync-kit/server' {
   *   interface CustomAccess { role: 'owner' | 'editor' | 'viewer' }
   * }
   */
  access?: CustomAccess
}

/**
 * Middleware function type.
 * Call `next()` to proceed to the next middleware or the mutation.
 * Throw an error to reject the mutation.
 */
export type Middleware = (
  ctx: MiddlewareContext,
  next: () => Promise<void>
) => Promise<void>

/**
 * Manages a chain of middleware functions executed before mutations.
 * Implements the Koa-style onion model where middleware wraps the core operation.
 *
 * @example
 * const middleware = new MiddlewareSystem()
 * middleware.use(async (ctx, next) => {
 *   console.log('Before:', ctx.action)
 *   await next()
 *   console.log('After:', ctx.action)
 * })
 */
export class MiddlewareSystem {
  private middlewares: Middleware[] = []

  /**
   * Adds a middleware to the chain.
   * @param middleware - Middleware function
   * @returns this for chaining
   */
  use(middleware: Middleware) {
    this.middlewares.push(middleware)
    return this
  }

  /**
   * Executes all middleware in sequence.
   * @param ctx - Middleware context
   */
  async execute(ctx: MiddlewareContext): Promise<void> {
    let index = 0
    const next = async () => {
      if (index < this.middlewares.length) {
        const middleware = this.middlewares[index++]
        await middleware(ctx, next)
      }
    }
    await next()
  }

  /**
   * Clears all registered middleware.
   */
  clear() {
    this.middlewares = []
  }
}
