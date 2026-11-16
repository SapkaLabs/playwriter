// The only browser transport owner. Terminating this dedicated worker destroys keys and netstack.
import { PUBLIC_DERP_MAP, MAX_CHUNK } from 'playwriter/src/tailcat-protocol'

type Conn = { port: number; read(): Promise<Uint8Array | null>; write(bytes: Uint8Array): Promise<void>; close(): void }
declare const self: {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
  Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }
  onTailcatReady: () => void
  tailcatListen(options: {
    derpMapURL: string
    onConnection(conn: Conn): void
  }): Promise<{ addr: string; close(): void }>
}

let connection: Conn | null = null
let listener: { close(): void } | null = null
let generation = 0
const reply = (id: number, result: unknown) => self.postMessage({ id, result })
const sockets = new Set<WebSocket>()
let cut = false
if (import.meta.env.TESTING) {
  const NativeWebSocket = globalThis.WebSocket
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const endpoint = new URL(String(url))
      const isDERP = endpoint.pathname === '/derp'
      if (isDERP && cut) {
        self.postMessage({ trace: { stage: 'derp-denied', endpoint: endpoint.origin, at: Date.now() } })
        throw new Error('Test DERP data route is cut')
      }
      super(url, protocols)
      if (!isDERP) return
      sockets.add(this)
      self.postMessage({ trace: { stage: 'derp-construct', endpoint: endpoint.origin, at: Date.now() } })
      this.addEventListener('open', () =>
        self.postMessage({ trace: { stage: 'derp-open', endpoint: endpoint.origin, at: Date.now() } }),
      )
      this.addEventListener('close', () => {
        sockets.delete(this)
        self.postMessage({ trace: { stage: 'derp-close', endpoint: endpoint.origin, at: Date.now() } })
      })
    }
  }
}

self.onmessage = async ({ data }) => {
  const { id, action } = data
  try {
    if (action === 'start') {
      const loaded = new Promise<void>((ok) => {
        self.onTailcatReady = ok
      })
      // No upstream demo code or remote executable scripts are used.
      importScripts(data.assetRoot + 'wasm_exec.js')
      const go = new self.Go()
      const response = await fetch(data.assetRoot + 'main.wasm')
      if (!response.ok) throw new Error('Packaged WASM is unavailable')
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject)
      void go.run(instance).catch(() => self.postMessage({ fatal: 'Go runtime stopped; sharing revoked' }))
      await loaded
      listener = await self.tailcatListen({
        derpMapURL: PUBLIC_DERP_MAP,
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
      if (cut) for (const socket of sockets) socket.close(4000, 'test data cut')
      reply(id, { tracked: sockets.size, cut })
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
