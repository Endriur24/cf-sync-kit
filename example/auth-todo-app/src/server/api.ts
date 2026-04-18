import { Hono } from 'hono'
import { createSyncApi, createDefaultSyncAccessValidator } from 'cf-sync-kit/server'
import { collectionsConfig } from '../../shared/schema'
import { getRoom } from './do'

const app = new Hono<{ Bindings: Bindings; Variables: { username: string } }>({ strict: false })
  .get('/me', (c) => {
    const username = c.get("username");
    return c.json({ authenticated: true, username });
  })

// Auth configuration:
// - getUserId: extracts the authenticated user from Hono context
// - validateSyncAccess: ensures users can only access their own sync scope
const syncApi = createSyncApi(collectionsConfig, getRoom, {
  getUserId: (c) => c.get('username') as string | undefined,
  validateSyncAccess: createDefaultSyncAccessValidator(),
})
app.route('/', syncApi) //not typed

export default app
export type AppType = typeof app
