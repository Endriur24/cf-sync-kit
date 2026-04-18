// Client
export { ConnectionProvider, useConnectionStatus } from './client/context/ConnectionContext'
export {
  useCollection,
  useUserCollection,
  useUserLiveSync,
  createSyncHooks,
  type UseCollectionOptions,
  type UseCollectionResult,
} from './client/hooks/useCollection'
export { useLiveSync, type UseLiveSyncOptions } from './client/hooks/useLiveSync'

// Shared Types
export type {
  ActionType,
  CollectionConfig,
  CollectionsMap,
  InferInsert,
  InferUpdate,
  InferEntity,
  MutationPayload,
  PendingMutationInfo,
  CollectionName,
  Scope,
  EntityMap,
  InsertMap,
  UpdateMap,
  WithId,
  CollectionKeys,
  ConnectionStatus,
} from './shared/types'
export { SyncError, isSyncError, defineCollections, DEFAULT_SYNC_ID } from './shared/types'

// Shared Events
export {
  WsEventSchema,
} from './shared/events'
export type {
  WsBroadcastEvent,
  WsSyncInitEvent,
  WsEvent,
} from './shared/events'
