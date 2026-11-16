import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectTailcat } from './tailcat-controller.js'

const registry =
  process.env.PLAYWRITER_TAILCAT_REGISTRY ||
  join(process.env.LOCALAPPDATA || homedir(), 'playwriter-tailcat', 'connections')
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)('whoami', [], { windowsHide: true })
    await promisify(execFile)('icacls', [directory, '/inheritance:r', '/grant:r', stdout.trim() + ':(OI)(CI)F'], {
      windowsHide: true,
    })
  } else if ((await stat(directory)).uid !== userInfo().uid)
    throw new Error('Connection registry is not owned by this user')
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  const { values } = parseArgs({
    args,
    options: {
      descriptor: { type: 'string' },
      listen: { type: 'string', default: '127.0.0.1:0' },
      connection: { type: 'string' },
      native: { type: 'string' },
    },
  })
  if (command === 'disconnect') {
    if (!/^[0-9a-f]{32}$/.test(values.connection || '')) throw new Error('Supply a local connection id')
    const file = join(registry, values.connection! + '.json')
    const control = JSON.parse(await readFile(file, 'utf8')) as { port: number; capability: string }
    const response = await fetch(`http://127.0.0.1:${control.port}/disconnect`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + control.capability },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error('Disconnect was rejected')
    console.log('Controller disconnected; browser sharing remains active until Stop sharing')
    return
  }
  if (command !== 'connect' || !values.descriptor)
    throw new Error(
      'Usage: playwriter-tailcat connect --descriptor <private-json-file> --listen 127.0.0.1:0 | disconnect --connection <id>',
    )
  const descriptorFile = resolve(values.descriptor)
  if ((await stat(descriptorFile)).size > 16 * 1024) throw new Error('Descriptor file exceeds 16 KiB')
  const descriptor = JSON.parse(await readFile(descriptorFile, 'utf8'))
  await privateDirectory(registry)
  const run = join(dirname(registry), 'runs', randomBytes(16).toString('hex'))
  await privateDirectory(run)
  const abort = new AbortController()
  let finish: () => void = () => {
    abort.abort()
  }
  process.on('SIGINT', () => finish())
  process.on('SIGTERM', () => finish())
  const connection = await connectTailcat({
    descriptor,
    nativePath:
      values.native ||
      fileURLToPath(
        new URL('../tailcat/' + (process.platform === 'win32' ? 'tailcat.exe' : 'tailcat'), import.meta.url),
      ),
    listen: values.listen,
    stateDirectory: run,
    signal: abort.signal,
    onFailure: (message) => {
      console.error(message)
      finish()
    },
  })
  const capability = randomBytes(32).toString('hex')
  let port = 0
  const server = createServer((request, response) => {
    if (
      request.method !== 'POST' ||
      request.url !== '/disconnect' ||
      request.headers.origin ||
      request.headers.host !== `127.0.0.1:${port}` ||
      request.headers.authorization !== 'Bearer ' + capability
    ) {
      response.writeHead(403).end()
      return
    }
    response.end('disconnected')
    finish()
  })
  await new Promise<void>((ok, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', ok)
  })
  const address = server.address()
  port = typeof address === 'object' && address ? address.port : 0
  const file = join(registry, connection.connectionId + '.json')
  await writeFile(file, JSON.stringify({ port, capability }), { mode: 0o600, flag: 'wx' })
  console.log(
    JSON.stringify({
      connection: connection.connectionId,
      host: connection.host,
      session: connection.sessionId,
      extensionId: connection.extensionId,
      adapterPid: connection.adapterPid,
      relayPid: connection.relayPid,
      nativePid: connection.nativePid,
      adapterPort: connection.adapterPort,
      command: `playwriter --host ${connection.host} -s ${connection.sessionId} -e <code>`,
    }),
  )
  await new Promise<void>((ok) => {
    finish = () => {
      abort.abort()
      ok()
    }
    if (abort.signal.aborted || connection.isTerminal()) finish()
  })
  await connection.close()
  server.close()
  await unlink(file).catch(() => {})
}

main().catch(() => {
  console.error(
    'Tailcat controller failed. Check descriptor, packaged assets and public connectivity; dispatched action outcome may be unknown.',
  )
  process.exitCode = 1
})
