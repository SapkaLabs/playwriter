import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative } from 'node:path'
import { parseArgs } from 'node:util'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'dist/public-derp')
const { values } = parseArgs({
  options: { go: { type: 'string', default: 'go' }, testing: { type: 'boolean', default: false } },
})
const pnpmScript = process.env.npm_execpath
if (!pnpmScript) throw new Error('Run through pnpm tailcat:build')
async function run(args, env = process.env) {
  await new Promise((ok, fail) => {
    const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: 'inherit' })
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`Build stage failed (${code})`))))
  })
}
await run(['scripts/build-tailcat.mjs', '--go', values.go])
await run([pnpmScript, '--filter', 'playwriter', 'build'])
const extensionOutput = join(root, 'extension/dist-derp-delivery')
if (relative(root, extensionOutput).replaceAll('\\', '/') !== 'extension/dist-derp-delivery')
  throw new Error('Unsafe extension output')
await rm(extensionOutput, { recursive: true, force: true })
await run([pnpmScript, '--filter', 'mcp-extension', 'build'], {
  ...process.env,
  PLAYWRITER_TAILCAT_ASSETS: join(root, 'dist/tailcat'),
  PLAYWRITER_EXTENSION_DIST: 'dist-derp-delivery',
  PLAYWRITER_PORT: '19987',
  PLAYWRITER_OPEN_WELCOME_PAGE: '0',
  TESTING: values.testing ? '1' : '',
  PRODUCTION: '',
})
await mkdir(output, { recursive: true })
await cp(join(root, 'extension/dist-derp-delivery'), join(output, 'extension'), { recursive: true })
// deploy provisions all runtime dependencies, including both local Playwright forks.
// Each output is unique: pnpm refuses to overwrite an existing controller folder.
const controller = join(output, 'controller')
if (relative(root, controller).replaceAll('\\', '/') !== 'dist/public-derp/controller')
  throw new Error('Unsafe controller output')
await rm(controller, { recursive: true, force: true })
await run([pnpmScript, '--filter', 'playwriter', 'deploy', '--prod', '--legacy', controller])
await cp(join(root, 'dist/tailcat'), join(controller, 'tailcat'), { recursive: true })
await writeFile(join(controller, 'playwriter.cmd'), '@echo off\r\nnode "%~dp0bin.js" %*\r\n')
await writeFile(join(controller, 'playwriter-tailcat.cmd'), '@echo off\r\nnode "%~dp0tailcat-bin.js" %*\r\n')
await cp(join(root, 'LICENSE'), join(output, 'LICENSE'))
const files = []
async function inventory(path, prefix = '') {
  for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) await inventory(join(path, entry.name), prefix + entry.name + '/')
    else if (entry.isFile()) {
      const bytes = await readFile(join(path, entry.name))
      files.push({
        path: prefix + entry.name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
}
await inventory(join(output, 'extension'), 'extension/')
await inventory(controller, 'controller/')
await writeFile(
  join(output, 'delivery.json'),
  JSON.stringify(
    {
      controller: controller.slice(output.length + 1).replaceAll('\\', '/'),
      node: process.version,
      requiredNode: JSON.parse(
        await readFile(join(controller, 'node_modules/@xmorse/playwright-core/package.json'), 'utf8'),
      ).engines.node,
      testing: values.testing,
      files,
    },
    null,
    2,
  ) + '\n',
)
console.log(`Developer bundles: ${output}`)
