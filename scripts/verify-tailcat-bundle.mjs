import { readFile, readdir, mkdtemp, cp, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'

const { values } = parseArgs({ options: { bundle: { type: 'string', default: 'dist/public-derp' } } })
const bundle = resolve(values.bundle)
const manifest = JSON.parse(await readFile(join(bundle, 'delivery.json'), 'utf8'))
for (const name of ['tailcat-LICENSE', 'go-LICENSE']) {
  await readFile(join(bundle, 'extension/tailcat/notices', name))
  await readFile(join(bundle, 'controller/tailcat/notices', name))
}
const expected = new Set()
for (const file of manifest.files) {
  const path = resolve(bundle, file.path)
  const relativePath = relative(bundle, path)
  if (isAbsolute(relativePath) || relativePath.startsWith('..') || expected.has(file.path)) {
    throw new Error('Unsafe or duplicate manifest path')
  }
  expected.add(file.path)
  const bytes = await readFile(path)
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    throw new Error(`Bundle hash mismatch: ${file.path}`)
  }
}
async function checkTree(directory, prefix) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const key = prefix + entry.name
    if (entry.isSymbolicLink()) throw new Error('Bundle contains a build-path link')
    if (entry.isDirectory()) await checkTree(path, key + '/')
    else if (!expected.has(key)) throw new Error(`Uninventoried bundle file: ${key}`)
  }
}
await checkTree(join(bundle, 'controller'), 'controller/')
await checkTree(join(bundle, 'extension'), 'extension/')
await stat(join(bundle, 'LICENSE'))

// Copy away from the checkout: absolute Windows junctions and missing production
// dependencies must fail here instead of silently resolving through the repo.
const relocated = await mkdtemp(join(tmpdir(), 'playwriter-derp-bundle-'))
try {
  await cp(join(bundle, 'controller'), relocated, { recursive: true })
  const run = promisify(execFile)
  const options = { cwd: relocated, windowsHide: true, timeout: 30_000, maxBuffer: 32768 }
  const cli = await run(process.execPath, [join(relocated, 'bin.js'), '--help'], options)
  if (!cli.stdout.includes('playwriter')) throw new Error('Relocated Playwriter help unavailable')
  const controller = await run(process.execPath, [join(relocated, 'tailcat-bin.js'), '--help'], options)
  if (!controller.stdout.includes('connect --descriptor')) throw new Error('Relocated controller unavailable')
  const native = join(relocated, 'tailcat', process.platform === 'win32' ? 'tailcat.exe' : 'tailcat')
  await run(native, ['--help'], options)
  console.log(
    JSON.stringify({
      sourceCommit: manifest.sourceCommit,
      sourceDirty: manifest.sourceDirty,
      testing: manifest.testing,
      verifiedFiles: expected.size,
      relocatedEntryPoints: 'passed',
    }),
  )
} finally {
  if (!relocated.startsWith(join(tmpdir(), 'playwriter-derp-bundle-')))
    throw new Error('Unexpected relocation directory')
  await rm(relocated, { recursive: true, force: true })
}
