import { createDurableObject, createGetRoomFn, requireAuth, requireOwner, createCollectionAccessMiddleware } from 'cf-sync-kit/server'
import { collectionsConfig } from '../../shared/schema'

export const { SyncRoom: ProjectRoom } = createDurableObject(collectionsConfig, {
  className: 'ProjectRoom',
  middleware: [
    requireAuth(),

    // Inject role into ctx.access based on userId
    // In a real app, you would fetch this from a database
    async (ctx, next) => {
      let role: 'viewer' | 'editor' | 'admin' = 'viewer'
      if (ctx.userId === 'admin') role = 'admin'
      else if (ctx.userId === 'editor') role = 'editor'

      ctx.access = {
        role,
        projectId: ctx.syncId.replace('project:', ''),
      }
      await next()
    },

    // Granular role-based rules (action-specific)
    createCollectionAccessMiddleware({
      todos: {
        insert: (ctx) => ctx.access?.role !== 'viewer',
        update: (ctx) => ctx.access?.role !== 'viewer',
        delete: (ctx) => ctx.access?.role === 'admin',
        'bulk-delete': (ctx) => ctx.access?.role === 'admin',
        '*': true,
      },
      '*': {
        '*': false,
      },
    }),

    requireOwner(),
  ],
})

export function getRoom(env: Bindings, syncId: string) {
  return createGetRoomFn(env.PROJECT_ROOM as DurableObjectNamespace<InstanceType<typeof ProjectRoom>>)(env, syncId)
}
