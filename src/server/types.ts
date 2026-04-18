/**
 * Custom access context injected by your auth/permission middleware.
 * Extend this interface via module augmentation to get type safety.
 *
 * @example
 * // In your app's server/middleware.ts
 * declare module 'cf-sync-kit/server' {
 *   interface CustomAccess {
 *     role: 'owner' | 'editor' | 'viewer'
 *     projectId: string
 *   }
 * }
 */
export interface CustomAccess {
  [key: string]: unknown
}
