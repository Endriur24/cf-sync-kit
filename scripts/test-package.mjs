import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = await import('../dist/index.js')

if (typeof entry.useCollection !== 'function') {
  throw new Error('dist/index.js does not expose the client entry point')
}
const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))
const serverSource = await readFile(serverPath, 'utf8')
const specifiers = [...serverSource.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)].map(match => match[1])
for (const specifier of specifiers) {
  if (!specifier.endsWith('.js')) throw new Error(`Server entry has an extensionless import: ${specifier}`)
  await access(resolve(dirname(serverPath), specifier))
}
