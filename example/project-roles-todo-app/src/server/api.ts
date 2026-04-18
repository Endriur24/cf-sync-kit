import { Hono } from 'hono'
import { createSyncApi } from 'cf-sync-kit/server'
import { collectionsConfig } from '../../shared/schema'
import { getRoom } from './do'

const app = new Hono<{ Bindings: Bindings; Variables: any }>({ strict: false })
  .get('/me', (c) => {
    const username = c.get("username");
    return c.json({ authenticated: true, username });
  })

// Auth configuration:
// - getUserId: extracts the authenticated user from Hono context
// Authorization is handled in the Durable Object via role-based middleware
const syncApi = createSyncApi(collectionsConfig, getRoom, {
  getUserId: (c) => c.get('username') as string | undefined,
})
app.route('/', syncApi)

export default app
export type AppType = typeof app
