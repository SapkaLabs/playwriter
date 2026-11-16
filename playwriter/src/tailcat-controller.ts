import { createHash, randomBytes } from 'node:crypto'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'
import { FramedStream, MAX_CHUNK, MAX_PENDING, PUBLIC_DERP_MAP } from './tailcat-protocol.js'

const exec = promisify(execFile)
export type Descriptor = {
  v: 1
  transport: 'playwriter-tailcat'
  addr: string
  port: 1
  relayMode: 'public'
  derpMapURL: string
}

async function validateDescriptor(value: unknown, nativePath: string): Promise<Descriptor> {
  const descriptor = value as Descriptor
  if (
    !descriptor ||
    descriptor.v !== 1 ||
    descriptor.transport !== 'playwriter-tailcat' ||
    descriptor.port !== 1 ||
    descriptor.relayMode !== 'public' ||
    descriptor.derpMapURL !== PUBLIC_DERP_MAP ||
    typeof descriptor.addr !== 'string' ||
    !/^tc[A-Za-z0-9_-]{20,8192}$/.test(descriptor.addr)
  )
    throw new Error('Unsupported public Tailcat descriptor')
  let parsed: { PresharedKey?: string; ServerPublic?: string; RegionID?: number; Region?: unknown[] }
  try {
    const result = await exec(nativePath, ['parse', descriptor.addr], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 32768,
    })
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error('Malformed Tailcat address')
  }
  // This PoC accepts only short, public map references, never embedded relay destinations.
  if (
    !/^psk:[0-9a-f]{64}$/.test(parsed.PresharedKey ?? '') ||
    /^psk:0+$/.test(parsed.PresharedKey ?? '') ||
    !parsed.ServerPublic ||
    ![301, 302, 303, 304].includes(parsed.RegionID ?? 0) ||
    parsed.Region?.length
  ) {
    throw new Error('Address requires a nonzero PSK and an approved public DERP region')
  }
  return descriptor
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
  onFailure?(message: string): void
}) {
  const descriptor = await validateDescriptor(options.descriptor, options.nativePath)
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
  const path = `/tunnel/${localId}/extension`
  let terminal = false
  let sessionId = ''
  let host = ''
  let relay: ChildProcess | undefined
  let socket: WebSocket | null = null
  let nativePid = 0
  let queuedBytes = 0
  const queued: string[] = []
  const server = createServer((_request, response) => {
    response.writeHead(404).end()
  })
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false })
  const native = ownedChild('./tailcat-native', [options.nativePath, descriptor.addr], env)
  native.on('message', (message: any) => {
    if (message.nativePid) nativePid = message.nativePid
  })
  const startup = setTimeout(() => fail('Native startup timed out (60 s)'), 60_000)
  const stream = new FramedStream({
    // The pinned CLI exposes establishment through its first output bytes; the
    // independent 60 s startup timer bounds silent Ping/Dial before that point.
    handshakeStartsOnRead: true,
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
      if (socket) await sendWS(json)
      else {
        const size = Buffer.byteLength(json) * 2
        if (queuedBytes + size > MAX_PENDING) throw new Error('Initial event queue exceeds 32 MiB')
        queuedBytes += size
        queued.push(json)
      }
    },
    onError: (error) => fail(error.message),
  })
  const failures: string[] = []
  function fail(message: string) {
    if (terminal) return
    failures.push(message)
    options.onFailure?.(message + '; outcome unknown for dispatched actions; reconnect manually, do not retry blindly')
    void close()
  }
  async function close() {
    if (terminal) return
    terminal = true
    clearTimeout(startup)
    stream.close()
    socket?.terminate()
    queued.length = 0
    queuedBytes = 0
    if (sessionId && host)
      await fetch(host + '/cli/session/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        signal: AbortSignal.timeout(1000),
      }).catch(() => {})
    // IPC disconnect triggers each child's owned-resource cleanup, including native on Windows.
    if (native.connected) native.disconnect()
    if (relay?.connected) relay.disconnect()
    setTimeout(() => {
      native.kill()
      relay?.kill()
    }, 1500).unref()
    wss.close()
    server.close()
  }
  async function sendWS(json: string) {
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount + Buffer.byteLength(json) * 2 > MAX_PENDING
    )
      throw new Error('Adapter WS queue exceeded or closed')
    await new Promise<void>((ok, reject) => socket!.send(json, (error) => (error ? reject(error) : ok())))
  }
  native.once('error', () => fail('Native pipe supervisor failed'))
  native.once('exit', () => fail('Native pipe supervisor exited'))
  native.stdout!.on('end', () => stream.end())
  native.stdout!.on('data', (bytes: Buffer) => {
    native.stdout!.pause()
    void (async () => {
      for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK)
        await stream.receive(bytes.subarray(offset, offset + MAX_CHUNK))
    })()
      .then(() => native.stdout!.resume())
      .catch(() => fail('Native frame ingress failed'))
  })
  try {
    await stream.start()
    await stream.ready
    clearTimeout(startup)
    let claimed = false
    let wsIngress: Promise<void> = Promise.resolve()
    let ingressBytes = 0
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
        ws.on('close', () => fail('Relay adapter connection closed'))
        ws.on('error', () => fail('Relay adapter socket failed'))
        ws.on('message', (data, binary) => {
          if (terminal) return
          const size =
            (Array.isArray(data)
              ? data.reduce((sum, chunk) => sum + chunk.length, 0)
              : data instanceof ArrayBuffer
                ? data.byteLength
                : data.length) * 2
          if (binary || ingressBytes + size > MAX_PENDING) {
            fail('Invalid or overflowing relay frame')
            return
          }
          ingressBytes += size
          const json = data.toString()
          wsIngress = wsIngress
            .then(async () => {
              if (terminal) return
              await stream.send(json)
            })
            .finally(() => {
              ingressBytes -= size
            })
          void wsIngress.catch(() => fail('Native frame write failed; outcome unknown'))
        })
        void (async () => {
          for (const json of queued) await sendWS(json)
          queued.length = 0
          queuedBytes = 0
        })().catch(() => fail('Initial event forwarding failed'))
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
    relay = ownedChild('./tailcat-relay', [String(relayPort), options.stateDirectory], env)
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
      connectionId: localId,
      host,
      sessionId,
      extensionId: expected,
      adapterPort,
      relayPort,
      nativePid,
      relayPid: relay.pid,
      adapterPid: process.pid,
      failures,
      close,
      isTerminal: () => terminal,
    }
  } catch (error) {
    await close()
    throw new Error(failures[0] || (error instanceof Error ? error.message : 'Tailcat connect failed'))
  }
}
