import { spawn, execFileSync } from 'node:child_process'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function run(command, args, cwd = root) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'inherit' })
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`Bootstrap stage failed (${code})`))))
  })
}
await run('git', ['submodule', 'update', '--init'])
// Git's core.autocrlf can make git apply reject an otherwise unchanged patch.
// Normalize only its working-copy line endings; the submodule content/pin stays unchanged.
const patch = join(root, 'patchright-playwriter/playwriter.patch')
const text = await readFile(patch, 'utf8')
await writeFile(patch, text.replaceAll('\r\n', '\n'))
let bash = 'bash'
if (process.platform === 'win32') {
  const gitExec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim()
  const gitBash = resolve(gitExec, '../../../bin/bash.exe')
  if (!(await stat(gitBash).catch(() => null)))
    throw new Error('Git for Windows Bash is required for Patchright bootstrap')
  bash = gitBash
}
await run(bash, ['utils/rebuild_local_package.sh'], join(root, 'patchright-playwriter'))
if (!process.env.npm_execpath) throw new Error('Run bootstrap through pnpm')
await run(process.execPath, [process.env.npm_execpath, 'install'])
await run(process.execPath, ['playwright/packages/playwright-core/build.mjs'])
