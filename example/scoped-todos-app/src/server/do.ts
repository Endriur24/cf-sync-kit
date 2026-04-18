import { createDurableObject, createGetRoomFn } from 'cf-sync-kit/server'
import { collectionsConfig } from '../../shared/schema'

export const { SyncRoom: ProjectRoom } = createDurableObject(collectionsConfig, {
  className: 'ProjectRoom',
})

export function getRoom(env: Bindings) {
  return createGetRoomFn(env.PROJECT_ROOM as DurableObjectNamespace<InstanceType<typeof ProjectRoom>>)(env, '_default')
}
