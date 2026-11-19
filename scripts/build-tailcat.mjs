import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const PIN = 'e00cdde6ff787f801361ff85ed085775c775d4c5'
const UPSTREAM = 'https://github.com/tailscale/tailcat'
const { values } = parseArgs({
  options: {
    go: { type: 'string', default: 'go' },
    cache: { type: 'string', default: 'tmp/tailcat-build' },
    out: { type: 'string', default: 'dist/tailcat' },
    verify: { type: 'boolean', default: false },
  },
})
const cache = resolve(values.cache)
const out = resolve(values.out)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function run(command, args, cwd, env = process.env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolveResult(output.trim()) : reject(new Error(`${command} failed (${code})`)),
    )
  })
}

async function inventory(directory, prefix = '') {
  const files = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const name = prefix + entry.name
    if (entry.isDirectory()) files.push(...(await inventory(join(directory, entry.name), name + '/')))
    else if (name !== 'manifest.json') {
      const bytes = await readFile(join(out, name))
      files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) })
    }
  }
  return files
}

async function main() {
  if (values.verify) {
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'))
    if (manifest.source.commit !== PIN) throw new Error('Unexpected Tailcat source pin')
    for (const file of manifest.files) {
      if (!/^[\w./-]+$/.test(file.path) || file.path.split('/').includes('..')) throw new Error('Invalid manifest path')
      const bytes = await readFile(join(out, file.path))
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
        throw new Error(`Artifact mismatch: ${file.path}`)
    }
    console.log('Tailcat artifact hashes verified')
    return
  }

  await mkdir(cache, { recursive: true })
  const source = join(cache, 'source')
  if (!(await stat(join(source, '.git')).catch(() => null)))
    await run('git', ['clone', '--no-checkout', UPSTREAM, source], cache)
  const origin = await run('git', ['remote', 'get-url', 'origin'], source)
  if (origin.replace(/\.git$/, '') !== UPSTREAM) throw new Error('Build cache is not the approved upstream')
  if (await run('git', ['status', '--porcelain'], source))
    throw new Error('Build cache source has changes; use a clean cache')
  await run('git', ['checkout', '--detach', PIN], source)
  if ((await run('git', ['rev-parse', 'HEAD'], source)) !== PIN) throw new Error('Tailcat pin mismatch')

  const go = values.go === 'go' ? 'go' : resolve(values.go)
  const env = {
    ...process.env,
    PATH: (go === 'go' ? '' : dirname(go) + delimiter) + process.env.PATH,
    GOTOOLCHAIN: 'local',
    GOMODCACHE: join(cache, 'modcache'),
    GOCACHE: join(cache, 'gocache'),
    CGO_ENABLED: '0',
    GOFLAGS: '-trimpath -buildvcs=false',
  }
  const toolchain = await run(go, ['version'], source, env)
  if (!/^go version go1\.27\.2 /.test(toolchain)) throw new Error('Approved Tailcat pin requires Go 1.27.2')
  await mkdir(out, { recursive: true })
  // Use the unchanged upstream builder; export only runtime assets, never its demo/fallback JS.
  await run(go, ['run', './cmd/tailcat-webdist', '-o', join(cache, 'webdist')], source, env)
  for (const name of ['main.wasm', 'wasm_exec.js']) await cp(join(cache, 'webdist', name), join(out, name))
  const tags = (await readFile(join(source, 'build-tags.txt'), 'utf8')).trim()
  const native = process.platform === 'win32' ? 'tailcat.exe' : 'tailcat'
  await run(go, ['build', '-tags', tags, '-o', join(out, native), './cmd/tailcat'], source, env)
  // Compile our small entry point outside the untouched upstream checkout, using
  // exactly its dependency graph and sums. The local replace selects the checked pin.
  const launcher = join(cache, 'launcher')
  await mkdir(launcher, { recursive: true })
  const launcherSource = await readFile(new URL('../playwriter/src/tailcat-tunnel/launcher/main.go', import.meta.url))
  const upstreamMod = await readFile(join(source, 'go.mod'), 'utf8')
  await writeFile(join(launcher, 'main.go'), launcherSource)
  await writeFile(
    join(launcher, 'go.mod'),
    upstreamMod.replace('module github.com/tailscale/tailcat', 'module playwriter.local/tailcat-launcher') +
      '\nrequire github.com/tailscale/tailcat v0.0.0\nreplace github.com/tailscale/tailcat => ' +
      JSON.stringify(source.replaceAll('\\', '/')) +
      '\n',
  )
  await cp(join(source, 'go.sum'), join(launcher, 'go.sum'))
  const launcherName = process.platform === 'win32' ? 'tailcat-launcher.exe' : 'tailcat-launcher'
  await run(go, ['build', '-mod=readonly', '-tags', tags, '-o', join(out, launcherName), '.'], launcher, env)
  await mkdir(join(out, 'notices'), { recursive: true })
  await cp(join(source, 'LICENSE'), join(out, 'notices', 'tailcat-LICENSE'))
  const goroot = await run(go, ['env', 'GOROOT'], source, env)
  await cp(join(goroot, 'LICENSE'), join(out, 'notices', 'go-LICENSE'))
  const modules = await run(go, ['list', '-m', '-f', '{{.Path}}|{{.Version}}|{{.Dir}}', 'all'], source, env)
  const dependencies = []
  for (const line of modules.split(/\r?\n/)) {
    const [path, version, directory] = line.split('|')
    dependencies.push({ path, version })
    if (!directory || path === 'github.com/tailscale/tailcat') continue
    for (const entry of await readdir(directory)) {
      if (/^(LICENSE|COPYING|NOTICE)([.-].*)?$/i.test(entry) && (await stat(join(directory, entry))).isFile()) {
        await cp(join(directory, entry), join(out, 'notices', path.replaceAll('/', '_') + '-' + entry))
      }
    }
  }
  await writeFile(
    join(out, 'manifest.json'),
    JSON.stringify(
      {
        source: { repository: UPSTREAM, commit: PIN, goSumSHA256: sha256(await readFile(join(source, 'go.sum'))) },
        toolchain,
        platform: process.platform,
        architecture: process.arch,
        nativeTags: tags,
        wasmBuilder: 'go run ./cmd/tailcat-webdist',
        launcher: { source: 'playwriter/src/tailcat-tunnel/launcher/main.go', sha256: sha256(launcherSource) },
        goflags: env.GOFLAGS,
        publicMap: 'https://tailcat.dev/derpmap.json',
        dependencies,
        files: await inventory(out),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`Pinned Tailcat artifacts: ${out}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
