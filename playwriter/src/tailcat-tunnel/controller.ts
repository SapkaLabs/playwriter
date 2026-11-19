import { createHash, randomBytes } from 'node:crypto'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'
import { FramedStream, PendingDataBudget, MAX_CHUNK, type FrameMetadata } from './protocol.js'
import { descriptorConfiguration, validateSessionHello, type Descriptor } from './descriptor.js'
import { fetchDERPMap } from './map.js'
import { ConfigurationError } from './config.js'

const exec = promisify(execFile)
export type { Descriptor } from './descriptor.js'

async function validateDescriptor(
  value: unknown,
  nativePath: string,
  assertedURL?: string,
): Promise<{ descriptor: Descriptor; regionId: number }> {
  const descriptor = descriptorConfiguration(value, assertedURL)
  let parsed: { PresharedKey?: string; ServerPublic?: string; RegionID?: number; Region?: unknown[] }
  try {
    const result = await exec(nativePath, ['parse', descriptor.addr], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 32768,
    })
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new ConfigurationError(
        'TRANSPORT_UNAVAILABLE',
        'Tailcat native runtime is missing. Use the Tailcat developer bundle.',
      )
    }
    throw new ConfigurationError('DESCRIPTOR_INVALID', 'Malformed Tailcat address')
  }
  // Short addresses select a region from the validated map, never embedded destinations.
  if (
    !/^psk:[0-9a-f]{64}$/.test(parsed.PresharedKey ?? '') ||
    /^psk:0+$/.test(parsed.PresharedKey ?? '') ||
    !parsed.ServerPublic ||
    !(descriptor.v === 1
      ? [301, 302, 303, 304].includes(parsed.RegionID ?? 0)
      : descriptor.regionId === parsed.RegionID) ||
    parsed.Region?.length
  ) {
    throw new ConfigurationError(
      'DESCRIPTOR_INVALID',
      'Address requires a nonzero PSK, server key and matching configured region',
    )
  }
  return { descriptor, regionId: parsed.RegionID! }
}

function ownedChild(module: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  return spawn(
    process.execPath,
    [
      ...(extension === '.ts' ? ['--import', 'tsx'] : []),
      fileURLToPath(new URL(module + extension, import.meta.url)),
      ...args,
    ],
    {
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
    },
  )
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((ok, fail) => {
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', ok)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((ok) => probe.close(() => ok()))
  return port
}

export async function connectTailcat(options: {
  descriptor: unknown
  nativePath: string
  stateDirectory: string
  listen?: string
  assertedMapURL?: string
  onFailure?(message: string): void
  signal?: AbortSignal
  testBeforeWrite?(frame: FrameMetadata): Promise<void>
}) {
  const startedAt = Date.now()
  const { descriptor, regionId } = await validateDescriptor(
    options.descriptor,
    options.nativePath,
    options.assertedMapURL,
  )
  const configuration = await fetchDERPMap(descriptor.derpMapURL, {
    signal: options.signal,
    regionId,
    expectedHash: descriptor.v === 2 ? descriptor.derpMapSha256 : undefined,
  })
  options.signal?.throwIfAborted()
  if (!/^127\.0\.0\.1:(0|[1-9]\d{0,4})$/.test(options.listen ?? '127.0.0.1:0'))
    throw new Error('Listen must be 127.0.0.1:<port>')
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 })
  const env = {
    ...process.env,
    PLAYWRITER_TELEMETRY: '0',
    PLAYWRITER_EXEC_TIMEOUT: '30000',
    LOCALAPPDATA: join(options.stateDirectory, 'cache'),
    APPDATA: join(options.stateDirectory, 'config'),
    XDG_CACHE_HOME: join(options.stateDirectory, 'cache'),
    XDG_CONFIG_HOME: join(options.stateDirectory, 'config'),
    PLAYWRITER_LOG_FILE_PATH: join(options.stateDirectory, 'relay.log'),
    PLAYWRITER_CDP_LOG_FILE_PATH: join(options.stateDirectory, 'cdp.jsonl'),
  }
  for (const key of [
    'PLAYWRITER_TOKEN',
    'PLAYWRITER_HOST',
    'PLAYWRITER_SESSION',
    'PLAYWRITER_REMOTE',
    'TAILCAT_DERPMAP_URL',
  ])
    delete env[key as keyof typeof env]
  const localId = randomBytes(16).toString('hex')
  const connectionId = randomBytes(16).toString('hex')
  const path = `/tunnel/${localId}/extension`
  let terminal = false
  let disposal: Promise<void> = Promise.resolve()
  let sessionId = ''
  let host = ''
  let relay: ChildProcess | undefined
  let socket: WebSocket | null = null
  let nativePid = 0
  const requests = new Map<number, ReturnType<typeof setTimeout>>()
  const trace: Array<Record<string, unknown>> = []
  const budget = new PendingDataBudget()
  let attach: () => void = () => {}
  let cancelAttach: (error: Error) => void = () => {}
  const attached = new Promise<void>((ok, reject) => {
    attach = ok
    cancelAttach = reject
  })
  void attached.catch(() => {})
  const server = createServer((_request, response) => {
    response.writeHead(404).end()
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false })
  let established!: () => void
  let rejectEstablished!: (error: Error) => void
  const establishment = new Promise<void>((ok, reject) => {
    established = ok
    rejectEstablished = reject
  })
  void establishment.catch(() => {})
  const launcherPath = join(
    dirname(options.nativePath),
    process.platform === 'win32' ? 'tailcat-launcher.exe' : 'tailcat-launcher',
  )
  const nativeConfig = join(options.stateDirectory, `transport-${connectionId}.json`)
  await writeFile(nativeConfig, JSON.stringify({ ...configuration, addr: descriptor.addr }), {
    mode: 0o600,
    flag: 'wx',
  })
  const native = ownedChild('./native', [launcherPath, nativeConfig], env)
  let remoteGeneration: number | null = descriptor.v === 1 ? 0 : null
  native.on('message', (message: any) => {
    if (message.nativePid) nativePid = message.nativePid
    if (!terminal && message.stage === 'stream-established') {
      clearTimeout(startup)
      established()
    }
    if (process.env.PLAYWRITER_TAILCAT_TESTS === '1' && Number.isSafeInteger(message.pipeReadBytes)) {
      trace.push({ stage: 'native-child-read', at: Date.now(), bytes: message.pipeReadBytes })
      if (trace.length > 512) trace.shift()
    }
  })
  const startup = setTimeout(
    () => fail('Native startup timed out (60 s)'),
    Math.max(1, 60_000 - (Date.now() - startedAt)),
  )
  const stream = new FramedStream({
    budget,
    beforeWriteRecord: process.env.PLAYWRITER_TAILCAT_TESTS === '1' ? options.testBeforeWrite : undefined,
    onFrame: (frame) => {
      trace.push({ stage: 'controller-frame', at: Date.now(), ...frame })
      if (trace.length > 512) trace.shift()
      if (frame.direction === 'write' && frame.id !== undefined && frame.method) {
        if (requests.has(frame.id)) throw new Error('Duplicate outstanding extension request')
        requests.set(
          frame.id,
          setTimeout(() => fail('Fixture command timed out (30 s); outcome unknown'), 30_000),
        )
      }
    },
    write: (bytes) =>
      new Promise((ok, reject) => {
        if (terminal || !native.stdin) {
          reject(new Error('Terminal connection generation'))
          return
        }
        native.stdin.write(bytes, (error) => (error ? reject(error) : ok()))
      }),
    onMessage: async (json) => {
      if (terminal) return
      const message = JSON.parse(json)
      if (descriptor.v === 2 && message.method === 'hello') {
        if (remoteGeneration !== null) throw new ConfigurationError('SESSION_MISMATCH', 'Repeated session hello')
        remoteGeneration = validateSessionHello(descriptor, message.params?.tailcatSession)
      }
      if (remoteGeneration === null)
        throw new ConfigurationError('SESSION_MISMATCH', 'Missing authenticated session hello')
      if (typeof message.id === 'number' && !message.method) {
        clearTimeout(requests.get(message.id))
        requests.delete(message.id)
      }
      // Retain only this decoded record until the real relay attaches. Pull-based
      // native reads backpressure subsequent events rather than duplicating queues.
      await attached
      if (!terminal) await sendWS(json)
    },
    onError: (error) => fail(error.message),
  })
  const failures: string[] = []
  let reportedFailure = false
  function fail(message: string) {
    if (terminal) return
    failures.push(message)
    reportedFailure = true
    options.onFailure?.(message + '; outcome unknown for dispatched actions; reconnect manually, do not retry blindly')
    void close()
  }
  async function close() {
    if (terminal) return disposal
    terminal = true
    disposal = new Promise<void>((resolve) => {
      if (native.exitCode !== null) {
        resolve()
        return
      }
      native.once('exit', () => resolve())
      setTimeout(resolve, 2200).unref()
    })
    if (requests.size && !reportedFailure) {
      const message = 'Controller disconnected with dispatched commands; outcome unknown. Re-observe before retrying.'
      failures.push(message)
      options.onFailure?.(message)
    }
    clearTimeout(startup)
    rejectEstablished(new Error('Native stream establishment cancelled'))
    for (const timer of requests.values()) clearTimeout(timer)
    requests.clear()
    // Terminate the dedicated relay before releasing its browser socket. Otherwise
    // a pending Playwright call may settle during detach and look like a completed
    // script. Closing the HTTP connection reports the dispatched outcome as unknown.
    relay?.kill()
    stream.close()
    socket?.terminate()
    cancelAttach(new Error('Connection generation is closed'))
    // The relay owns only this connection's in-memory session; process disposal
    // removes it and prevents stock remote redials from reviving the generation.
    // IPC disconnect triggers each child's owned-resource cleanup, including native on Windows.
    if (native.connected) native.disconnect()
    if (relay?.connected) relay.disconnect()
    setTimeout(() => {
      native.kill()
      relay?.kill()
    }, 2000).unref()
    wss.close()
    server.close()
    await unlink(nativeConfig).catch(() => {})
    await disposal
  }
  options.signal?.addEventListener(
    'abort',
    () => {
      void close()
    },
    { once: true },
  )
  if (options.signal?.aborted) {
    await close()
    throw new Error('Controller startup cancelled')
  }
  async function sendWS(json: string) {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Adapter WS queue exceeded or closed')
    const release = budget.reserve(Buffer.byteLength(json))
    try {
      await new Promise<void>((ok, reject) => socket!.send(json, (error) => (error ? reject(error) : ok())))
    } finally {
      release()
    }
  }
  native.once('error', () => fail('Native pipe supervisor failed'))
  native.once('exit', () => fail('Native pipe supervisor exited'))
  native.stdout!.on('end', () => stream.end())
  native.stdout!.on('data', (bytes: Buffer) => {
    native.stdout!.pause()
    if (process.env.PLAYWRITER_TAILCAT_TESTS === '1') {
      trace.push({ stage: 'native-pipe-read', at: Date.now(), bytes: bytes.length })
      if (trace.length > 512) trace.shift()
    }
    void (async () => {
      for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK)
        await stream.receive(bytes.subarray(offset, offset + MAX_CHUNK))
    })()
      .then(() => {
        if (process.env.PLAYWRITER_TAILCAT_TESTS === '1') {
          trace.push({ stage: 'native-pipe-resume', at: Date.now() })
          if (trace.length > 512) trace.shift()
        }
        native.stdout!.resume()
      })
      .catch(() => fail('Native frame ingress failed'))
  })
  // IPC and stdout are independent pipes. Hold binary ingress until the local
  // launcher notification arrives; neither a peer byte nor buffering proves Dial.
  native.stdout!.pause()
  try {
    await establishment
    await stream.start()
    native.stdout!.resume()
    await stream.ready
    clearTimeout(startup)
    let claimed = false
    server.on('upgrade', (request, peer, head) => {
      if (
        terminal ||
        claimed ||
        request.url !== path ||
        request.headers.origin ||
        request.headers.host !== `127.0.0.1:${adapterPort}`
      ) {
        peer.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      claimed = true
      wss.handleUpgrade(request, peer, head, (ws) => {
        socket = ws
        attach()
        ws.on('close', () => fail('Relay adapter connection closed'))
        ws.on('error', () => fail('Relay adapter socket failed'))
        ws.on('message', (data, binary) => {
          if (terminal) return
          if (remoteGeneration === null) {
            fail('SESSION_MISMATCH: session not verified')
            return
          }
          if (binary || !Buffer.isBuffer(data)) {
            fail('Invalid or overflowing relay frame')
            return
          }
          // Framing owns this raw record and its shared quota; do not retain an
          // additional JSON/encoded copy in a second adapter queue.
          void stream.sendRecord(data).catch(() => fail('Native frame write failed; outcome unknown'))
        })
      })
    })
    await new Promise<void>((ok, reject) => {
      server.once('error', reject)
      server.listen(Number((options.listen ?? '127.0.0.1:0').split(':')[1]), '127.0.0.1', ok)
    })
    const address = server.address()
    const adapterPort = typeof address === 'object' && address ? address.port : 0
    const wsURL = `ws://127.0.0.1:${adapterPort}${path}`
    const relayPort = await freePort()
    host = `http://127.0.0.1:${relayPort}`
    relay = ownedChild('./relay', [String(relayPort), options.stateDirectory], env)
    relay.on('message', (message: any) => {
      if (message.executeFailed) fail('Fixture operation failed; outcome unknown')
    })
    relay.once('exit', () => fail('Owned relay exited'))
    await new Promise<void>((ok, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned relay startup timed out')), 15_000)
      relay!.once('message', (message: any) => {
        clearTimeout(timer)
        message.ready ? ok() : reject(new Error('Relay failed'))
      })
      relay!.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('Owned relay exited during startup'))
      })
    })
    const response = await fetch(host + '/cli/session/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remoteControlUrl: wsURL, tabGroup: 'derp', cwd: options.stateDirectory }),
      signal: AbortSignal.timeout(15_000),
    })
    const session = (await response.json()) as { id: string; mode: string; extensionId: string }
    const expected = 'remote:' + createHash('sha256').update(wsURL).digest('hex')
    if (!response.ok || session.mode !== 'remote' || session.extensionId !== expected || terminal)
      throw new Error('Real remote hello/targets or explicit session binding failed')
    sessionId = session.id
    return {
      connectionId,
      host,
      sessionId,
      extensionId: expected,
      adapterPort,
      relayPort,
      nativePid,
      relayPid: relay.pid,
      adapterPid: process.pid,
      failures,
      trace,
      close,
      isTerminal: () => terminal,
    }
  } catch (error) {
    await close()
    if (error instanceof ConfigurationError) throw error
    // Export only known local diagnostics, never native library error text.
    const failure = failures[0] ?? ''
    if (failure.startsWith('SESSION_MISMATCH:'))
      throw new ConfigurationError('SESSION_MISMATCH', 'Authenticated session does not match connection information')
    if (failure.includes('Preface exchange timed out'))
      throw new ConfigurationError('HANDSHAKE_TIMEOUT', 'Preface exchange timed out; reconnect manually')
    if (failure.includes('startup timed out'))
      throw new ConfigurationError('STARTUP_TIMEOUT', 'Selected server startup timed out; retry explicitly')
    throw new ConfigurationError(
      'CONTROLLER_UNAVAILABLE',
      'Selected peer is unreachable or busy; do not replace an active controller. Retry manually or Stop and Start sharing',
    )
  }
}
