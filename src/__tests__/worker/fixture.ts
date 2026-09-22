import { DurableObject } from 'cloudflare:workers'

export class TestRoom extends DurableObject<Cloudflare.Env> {

  async writeAndRead(key: string, value: string) {
    await this.env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS worker_runtime_test (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
    ).run()
    await this.env.DB.prepare(
      'INSERT OR REPLACE INTO worker_runtime_test (key, value) VALUES (?, ?)'
    ).bind(key, value).run()
    return this.env.DB.prepare(
      'SELECT value FROM worker_runtime_test WHERE key = ?'
    ).bind(key).first<{ value: string }>()
  }
}

export default {
  fetch(): Response {
    return new Response('worker fixture')
  },
}
