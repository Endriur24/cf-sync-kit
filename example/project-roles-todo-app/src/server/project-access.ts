import { Context, Next } from 'hono'
import type { Env } from '../types'

export type ProjectAccess = {
  hasAccess: boolean
  role: 'viewer' | 'editor' | 'admin' | 'owner'
  projectId: string
}

export type Variables = {
  username: string
  projectAccess: ProjectAccess
}

/**
 * Simple middleware for testing roles in this example.
 * In a real project, you would fetch this data from a database.
 * Here we simulate roles based on username + projectId.
 */
export async function projectAccessMiddleware(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next
) {
  const username = c.get('username')
  const projectId = c.req.param('projectId') || 'demo-project'

  if (!username) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  // Role simulation (in a real app you would fetch from DB)
  let role: 'viewer' | 'editor' | 'admin' | 'owner' = 'viewer'

  if (username === 'admin') role = 'owner'
  else if (username === 'editor') role = 'editor'
  else if (username === 'user') role = 'viewer'

  c.set('projectAccess', {
    hasAccess: true,
    role,
    projectId,
  })

  await next()
}
