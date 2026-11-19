import { rm, mkdir, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Node owns cleanup so this entry point runs identically under cmd, PowerShell and POSIX shells.
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(packageDirectory)
await rm('dist', { recursive: true, force: true })
for (const name of await readdir('.')) if (name.endsWith('.tsbuildinfo')) await rm(name)
await mkdir('dist')
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} failed (${code})`))))
  })
}
const bun = process.env.BUN_EXECUTABLE || 'bun'
await run(bun, ['scripts/build-client-bundles.ts'])
await run(process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc')])
await run(bun, ['scripts/build-extension-bundle.ts'])
await run(bun, ['scripts/build-resources.ts'])
