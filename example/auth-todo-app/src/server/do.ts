import { createDurableObject, createGetRoomFn } from 'cf-sync-kit/server'
import { collectionsConfig } from '../../shared/schema'

export const { SyncRoom: ProjectRoom } = createDurableObject(collectionsConfig, {
  className: 'ProjectRoom',
  preset: 'per-user',
})

export function getRoom(env: Bindings, syncId: string) {
  return createGetRoomFn(env.PROJECT_ROOM as DurableObjectNamespace<InstanceType<typeof ProjectRoom>>)(env, syncId)
}
