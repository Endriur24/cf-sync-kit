import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/__tests__/worker/fixture.ts',
      miniflare: {
        compatibilityDate: '2026-09-22',
        d1Databases: ['DB'],
        durableObjects: { TEST_ROOM: 'TestRoom' },
      },
    }),
  ],
  test: {
    include: ['src/__tests__/worker/**/*.test.ts'],
  },
})
