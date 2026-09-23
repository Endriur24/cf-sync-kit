/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    TEST_ROOM: DurableObjectNamespace<import('./fixture').TestRoom>
    OWNER_ROOM: DurableObjectNamespace<import('./fixture').OwnerRoom>
  }
}
