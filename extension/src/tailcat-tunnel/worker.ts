// The only browser transport owner. Terminating this dedicated worker destroys keys and netstack.
import { MAX_CHUNK } from 'playwriter/src/tailcat-tunnel/protocol'
import { freezeMap } from 'playwriter/src/tailcat-tunnel/map'

type Conn = { port: number; read(): Promise<Uint8Array | null>; write(bytes: Uint8Array): Promise<void>; close(): void }
declare const self: {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
  Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }
  onTailcatReady: () => void
  tailcatListen(options: {
    configuration: string
    onConnection(conn: Conn): void
  }): Promise<{ addr: string; close(): void }>
}

let connection: Conn | null = null
let listener: { close(): void } | null = null
let generation = 0
const reply = (id: number, result: unknown) => self.postMessage({ id, result })
const sockets = new Set<WebSocket>()
const socketIds = new WeakMap<WebSocket, number>()
let socketSequence = 0
let cut = false
// Observe transport availability without changing Tailcat's same-region retry
// policy. No endpoint or native error text leaves the worker in production.
{
  const NativeWebSocket = globalThis.WebSocket
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const endpoint = new URL(String(url))
      const isDERP = endpoint.pathname === '/derp'
      if (import.meta.env.TESTING && isDERP && cut) {
        self.postMessage({ trace: { stage: 'derp-denied', endpoint: endpoint.origin, at: Date.now() } })
        throw new Error('Test DERP data route is cut')
      }
      super(url, protocols)
      if (!isDERP) return
      const socketId = ++socketSequence
      socketIds.set(this, socketId)
      sockets.add(this)
      if (import.meta.env.TESTING)
        self.postMessage({ trace: { stage: 'derp-construct', socketId, endpoint: endpoint.origin, at: Date.now() } })
      const availability = () =>
        self.postMessage({ relayAvailable: Array.from(sockets).some((s) => s.readyState === WebSocket.OPEN) })
      this.addEventListener('open', () => {
        availability()
        if (import.meta.env.TESTING)
          self.postMessage({ trace: { stage: 'derp-open', socketId, endpoint: endpoint.origin, at: Date.now() } })
      })
      this.addEventListener('error', availability)
      this.addEventListener('close', () => {
        sockets.delete(this)
        availability()
        if (import.meta.env.TESTING)
          self.postMessage({ trace: { stage: 'derp-close', socketId, endpoint: endpoint.origin, at: Date.now() } })
      })
    }
  }
}

self.onmessage = async ({ data }) => {
  const { id, action } = data
  try {
    if (action === 'start') {
      const config = data.configuration
      const validated = await freezeMap(new TextEncoder().encode(config.mapJSON), config.derpMapURL, {
        expectedHash: config.derpMapSha256,
        regionId: config.regionId,
      })
      const loaded = new Promise<void>((ok) => {
        self.onTailcatReady = ok
      })
      // No upstream demo code or remote executable scripts are used.
      importScripts(data.assetRoot + 'wasm_exec.js')
      const go = new self.Go()
      const response = await fetch(data.assetRoot + 'main.wasm')
      if (!response.ok) throw new Error('Packaged WASM is unavailable')
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject)
      void go.run(instance).then(
        () => self.postMessage({ fatal: 'Go runtime stopped; sharing revoked' }),
        () => self.postMessage({ fatal: 'Go runtime stopped; sharing revoked' }),
      )
      await loaded
      listener = await self.tailcatListen({
        configuration: JSON.stringify(validated),
        onConnection: (conn) => {
          if (conn.port !== 1 || connection) {
            conn.close()
            return
          }
          connection = conn
          self.postMessage({ connected: ++generation })
        },
      })
      // privateKeyJSON intentionally never crosses the worker seam.
      reply(id, { addr: (listener as unknown as { addr: string }).addr })
    } else if (action === 'read') {
      if (!connection || data.generation !== generation) throw new Error('Connection generation is closed')
      const bytes = await connection.read()
      if (bytes && bytes.length > MAX_CHUNK) throw new Error('Native read exceeds 64 KiB')
      self.postMessage({ id, result: bytes }, bytes ? [bytes.buffer as ArrayBuffer] : [])
    } else if (action === 'write') {
      if (!connection || data.generation !== generation || data.bytes.length > MAX_CHUNK)
        throw new Error('Invalid connection write')
      await connection.write(data.bytes)
      reply(id, null)
    } else if (action === 'closeConnection') {
      if (data.generation === generation) {
        const old = connection
        connection = null
        old?.close()
      }
      reply(id, null)
    } else if (import.meta.env.TESTING && action === 'testCut') {
      cut = Boolean(data.cut)
      const trackedIds = Array.from(sockets, (socket) => socketIds.get(socket))
      if (cut) for (const socket of sockets) socket.close(4000, 'test data cut')
      reply(id, { tracked: sockets.size, trackedIds, cut })
    } else if (import.meta.env.TESTING && action === 'testDispose') {
      const old = connection
      connection = null
      old?.close()
      reply(id, null)
    } else throw new Error('Unknown worker command')
  } catch {
    // Tailcat errors can contain addresses. Export only stage names across this seam.
    self.postMessage({ id, error: `Tailcat ${action} failed` })
  }
}
