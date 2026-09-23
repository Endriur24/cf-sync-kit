import { rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = fileURLToPath(new URL('../dist', import.meta.url))

await rm(dist, { recursive: true, force: true })

await new Promise((resolve, reject) => {
  const tsc = spawn(process.execPath, ['./node_modules/typescript/bin/tsc', '--project', 'tsconfig.lib.json'], {
    cwd: root,
    stdio: 'inherit',
  })
  tsc.once('error', reject)
  tsc.once('exit', code => code === 0 ? resolve() : reject(new Error(`tsc exited with code ${code}`)))
})

const relativeSpecifier = /((?:from\s+|import\s*)['"])(\.\.?\/[^'"]+)(['"])/g

async function addEsmExtensions(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      await addEsmExtensions(path)
    } else if (entry.name.endsWith('.js')) {
      const source = await readFile(path, 'utf8')
      const rewritten = source.replace(relativeSpecifier, (_match, prefix, specifier, suffix) => {
        return /\.[a-z0-9]+$/i.test(specifier) ? `${prefix}${specifier}${suffix}` : `${prefix}${specifier}.js${suffix}`
      })
      if (rewritten !== source) await writeFile(path, rewritten)
    }
  }
}

await addEsmExtensions(dist)

async function embedSourceMapSources(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      await embedSourceMapSources(path)
      continue
    }
    if (!entry.name.endsWith('.map')) continue

    const sourceMap = JSON.parse(await readFile(path, 'utf8'))
    if (Array.isArray(sourceMap.sourcesContent)) continue
    sourceMap.sourcesContent = await Promise.all(
      sourceMap.sources.map(source => readFile(resolve(dirname(path), source), 'utf8')),
    )
    await writeFile(path, JSON.stringify(sourceMap))
  }
}

await embedSourceMapSources(dist)
