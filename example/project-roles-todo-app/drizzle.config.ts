import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './shared/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  driver: 'd1-http',
})
