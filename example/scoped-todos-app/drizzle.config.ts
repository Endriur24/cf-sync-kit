import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './shared/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DB_URL || './.wrangler/state/v3/d1/miniflare-D1DatabaseObject/dev.sqlite'
  },
})
