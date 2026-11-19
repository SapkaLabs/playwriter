import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir, unlink, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectTailcat } from './controller.js'
import { ConfigurationError, findProfile, type ProfileMutation } from './config.js'
import { withProfileFile, profileFilePath } from './profile-file.js'
import { fetchDERPMap } from './map.js'
import { descriptorConfiguration } from './descriptor.js'

const registry =
  process.env.PLAYWRITER_TAILCAT_REGISTRY ||
  join(process.env.LOCALAPPDATA || homedir(), 'playwriter-tailcat', 'connections')
let cliStage = 'arguments'
const usage =
  'playwriter-tailcat connect --descriptor <private-json-file> [--profile <name-or-id> | --derp-map-url <https-map-url>] [--config <file>] [--listen 127.0.0.1:0]\nplaywriter-tailcat disconnect --connection <id>\nplaywriter-tailcat profile list|add|edit|remove|select|validate [name-or-id] [--name <name>] [--derp-map-url <https-map-url>] [--none] [--config <file>]'
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
  if (command === '--help' || command === '-h') {
    console.log(usage)
    return
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      descriptor: { type: 'string' },
      listen: { type: 'string', default: '127.0.0.1:0' },
      connection: { type: 'string' },
      native: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      profile: { type: 'string' },
      'derp-map-url': { type: 'string' },
      config: { type: 'string' },
      name: { type: 'string' },
      none: { type: 'boolean' },
    },
  })
  if (values.help) {
    console.log(usage)
    return
  }
  if (command === 'profile') {
    const [action, reference] = positionals
    if (positionals.length > 2 || !['list', 'add', 'edit', 'remove', 'select', 'validate'].includes(action))
      throw new ConfigurationError('CONFIG_INVALID', usage)
    const result = await withProfileFile(profileFilePath(values.config), async (store) => {
      const data = await store.read()
      if (action === 'list') return data
      if (action === 'validate') {
        const map = await fetchDERPMap(findProfile(data, reference).derpMapURL)
        return {
          valid: true,
          regions: Object.values(map.map.Regions).map((r) => ({
            id: r.RegionID,
            nodes: r.Nodes.map((n) => `${n.HostName}:${n.DERPPort}`),
          })),
        }
      }
      if (values.none && (action !== 'select' || reference))
        throw new ConfigurationError('CONFIG_INVALID', '--none is only valid with profile select and no reference')
      if (!reference && !(action === 'select' && values.none))
        throw new ConfigurationError('PROFILE_REQUIRED', 'Supply a profile name or id')
      const change: ProfileMutation = { action: action as ProfileMutation['action'], expectedRevision: data.revision }
      if (action === 'add') {
        change.name = reference
        change.derpMapURL = values['derp-map-url']
      } else {
        change.id = values.none ? null : findProfile(data, reference).id
        if (action === 'edit') {
          change.name = values.name
          change.derpMapURL = values['derp-map-url']
        }
      }
      return store.update(change)
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (positionals.length) throw new ConfigurationError('CONFIG_INVALID', 'Unexpected positional arguments')
  if (command === 'disconnect') {
    if (!/^[0-9a-f]{32}$/.test(values.connection || '')) throw new Error('Supply a local connection id')
    const file = join(registry, values.connection! + '.json')
    cliStage = 'disconnect control'
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
  cliStage = 'descriptor'
  if ((await stat(descriptorFile)).size > 16 * 1024) throw new Error('Descriptor file exceeds 16 KiB')
  const descriptor = JSON.parse(await readFile(descriptorFile, 'utf8'))
  if (values.profile && values['derp-map-url'])
    throw new ConfigurationError('SERVER_MISMATCH', '--profile and --derp-map-url are mutually exclusive')
  const assertedMapURL =
    values.profile !== undefined
      ? await withProfileFile(
          profileFilePath(values.config),
          async (store) => findProfile(await store.read(), values.profile).derpMapURL,
        )
      : values['derp-map-url']
  const configuredDescriptor = descriptorConfiguration(descriptor, assertedMapURL)
  console.error(
    `Server configuration: ${configuredDescriptor.derpMapURL} (descriptor${assertedMapURL !== undefined ? ', explicit assertion matched' : ''})`,
  )
  cliStage = 'private registry'
  await privateDirectory(registry)
  const run = join(dirname(registry), 'runs', randomBytes(16).toString('hex'))
  await privateDirectory(run)
  const abort = new AbortController()
  let finish: () => void = () => {
    abort.abort()
  }
  process.on('SIGINT', () => finish())
  process.on('SIGTERM', () => finish())
  cliStage = 'native/preface/session startup'
  const connection = await connectTailcat({
    descriptor,
    assertedMapURL,
    nativePath:
      values.native ||
      fileURLToPath(
        new URL('../../tailcat/' + (process.platform === 'win32' ? 'tailcat.exe' : 'tailcat'), import.meta.url),
      ),
    listen: values.listen,
    stateDirectory: run,
    signal: abort.signal,
    onFailure: (message) => {
      console.error(message)
      finish()
    },
  })
  cliStage = 'controller control setup'
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
  let file: string | undefined
  try {
    await new Promise<void>((ok, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', ok)
    })
    const address = server.address()
    port = typeof address === 'object' && address ? address.port : 0
    file = join(registry, connection.connectionId + '.json')
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
        command: `playwriter --host ${connection.host} -s ${connection.sessionId} --timeout 30000 -e <code>`,
      }),
    )
    cliStage = 'active connection'
    await new Promise<void>((ok) => {
      finish = () => {
        abort.abort()
        ok()
      }
      if (abort.signal.aborted || connection.isTerminal()) finish()
    })
  } finally {
    await connection.close()
    server.close()
    if (file) await unlink(file).catch(() => {})
  }
}

main().catch((error) => {
  console.error(
    error instanceof ConfigurationError
      ? error.message
      : cliStage === 'active connection'
        ? 'Tailcat active connection failed; dispatched action outcome is unknown. Re-observe before retrying.'
        : `Tailcat ${cliStage} failed before publishing a ready connection. No CLI operation was submitted. Use --help for the command interface.`,
  )
  process.exitCode = 1
})
