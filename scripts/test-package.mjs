import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = await import('../dist/index.js')

if (typeof entry.useCollection !== 'function') {
  throw new Error('dist/index.js does not expose the client entry point')
}
const serverPath = fileURLToPath(new URL('../dist/server.js', import.meta.url))
const serverSource = await readFile(serverPath, 'utf8')
if (!serverSource.includes('createAnalyticsEngineSink')) {
  throw new Error('dist/server.js does not expose the Analytics Engine adapter')
}
const specifiers = [...serverSource.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)].map(match => match[1])
for (const specifier of specifiers) {
  if (!specifier.endsWith('.js')) throw new Error(`Server entry has an extensionless import: ${specifier}`)
  await access(resolve(dirname(serverPath), specifier))
}

async function verifySourceMaps(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name)
    if (item.isDirectory()) {
      await verifySourceMaps(path)
      continue
    }
    if (!item.name.endsWith('.map')) continue

    const sourceMap = JSON.parse(await readFile(path, 'utf8'))
    if (!Array.isArray(sourceMap.sourcesContent)) {
      throw new Error(`${path} does not embed sourcesContent`)
    }
    if (sourceMap.sourcesContent.length !== sourceMap.sources.length) {
      throw new Error(`${path} has incomplete sourcesContent`)
    }
    if (sourceMap.sourcesContent.some(source => typeof source !== 'string' || source.length === 0)) {
      throw new Error(`${path} contains a missing embedded source`)
    }
  }
}

await verifySourceMaps(fileURLToPath(new URL('../dist', import.meta.url)))
