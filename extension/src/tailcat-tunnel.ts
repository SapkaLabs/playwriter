import { FramedStream, PUBLIC_DERP_MAP, MAX_CHUNK } from 'playwriter/src/tailcat-protocol'
import type { RemoteTunnelOptions, TunnelConnectionHandlers } from './remote-tunnel'

export class TailcatTunnel {
  url = ''
  private readonly frames: Array<Record<string, unknown>> = []
  private readonly socketEvents: Array<Record<string, unknown>> = []
  get trace(): Array<Record<string, unknown>> {
    return [...this.socketEvents, ...this.frames]
  }
  private record(event: Record<string, unknown>): void {
    const events = String(event.stage).startsWith('derp-') ? this.socketEvents : this.frames
    events.push(event)
    if (events.length > (events === this.socketEvents ? 128 : 512)) events.shift()
  }
  test(action: string, data: Record<string, unknown> = {}): Promise<any> {
    if (!import.meta.env.TESTING) return Promise.reject(new Error('Test controls are unavailable'))
    if (action === 'dispose') this.closeGeneration(this.generation)
    return this.request(action === 'cut' ? 'testCut' : 'testDispose', data)
  }
  private port: chrome.runtime.Port | null = null
  private closed = false
  private serial = 0
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  private stream: FramedStream | null = null
  private startup: ReturnType<typeof setTimeout> | undefined
  private handlers: TunnelConnectionHandlers | null = null
  private generation = 0

  constructor(private options: RemoteTunnelOptions & { ensureOffscreen(): Promise<void>; onFatal(): void }) {}

  start(): void {
    void this.open().catch(() => {
      if (!this.closed) this.options.onFatal()
    })
  }

  private async open(): Promise<void> {
    this.startup = setTimeout(() => this.options.onFatal(), 60_000)
    await this.options.ensureOffscreen()
    if (this.closed) return
    const port = chrome.runtime.connect({ name: 'playwriter-tailcat' })
    this.port = port
    port.onDisconnect.addListener(() => {
      if (!this.closed) this.options.onFatal()
    })
    port.onMessage.addListener((data) => {
      if (this.closed) return
      if (data.trace) {
        this.record(data.trace)
        return
      }
      if (data.fatal) {
        this.options.onFatal()
        return
      }
      if (data.connected) {
        void this.accept(data.connected)
        return
      }
      const request = this.pending.get(data.id)
      if (!request) return
      this.pending.delete(data.id)
      if (data.error) request.reject(new Error(data.error))
      else request.resolve(data.result)
    })
    const { addr } = await this.request('start', { assetRoot: chrome.runtime.getURL('tailcat/') })
    if (this.closed) return
    this.url = JSON.stringify({
      v: 1,
      transport: 'playwriter-tailcat',
      addr,
      port: 1,
      relayMode: 'public',
      derpMapURL: PUBLIC_DERP_MAP,
    })
    clearTimeout(this.startup)
    this.options.onStatusChange('online')
  }

  private request(action: string, data: Record<string, unknown> = {}): Promise<any> {
    if (this.closed || !this.port) return Promise.reject(new Error('Sharing revoked'))
    return new Promise((resolve, reject) => {
      const id = ++this.serial
      this.pending.set(id, { resolve, reject })
      this.port!.postMessage({ id, action, ...data })
    })
  }

  private async accept(generation: number): Promise<void> {
    if (this.closed || this.stream) return
    this.generation = generation
    const stream = new FramedStream({
      onFrame: (frame) => {
        if (import.meta.env.TESTING) this.record({ stage: 'browser-frame', generation, at: Date.now(), ...frame })
      },
      write: async (bytes) => {
        if (import.meta.env.TESTING)
          this.record({ stage: 'browser-pipe-write', generation, bytes: bytes.length, at: Date.now() })
        await this.request('write', {
          generation,
          base64: btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')),
        })
      },
      onMessage: async (json) => {
        if (!this.closed && this.stream === stream) this.handlers?.onMessage(json)
      },
      onError: () => {
        this.closeGeneration(generation)
      },
    })
    this.stream = stream
    void (async () => {
      try {
        while (!this.closed && this.stream === stream) {
          const result = await this.request('read', { generation })
          if (result === null) {
            stream.end()
            break
          }
          const bytes = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0))
          if (import.meta.env.TESTING)
            this.record({ stage: 'browser-pipe-read', generation, bytes: bytes.length, at: Date.now() })
          if (bytes.length > MAX_CHUNK) throw new Error('Bridge chunk limit exceeded')
          await stream.receive(bytes)
        }
      } catch {
        this.closeGeneration(generation)
      }
    })()
    await stream.start()
    try {
      await stream.ready
    } catch {
      return
    }
    if (this.closed || this.stream !== stream) return
    this.handlers = this.options.onConnectionOpen({
      id: String(generation),
      send: (json) => {
        void stream.send(json).catch(() => this.closeGeneration(generation))
      },
      canSendScreencastFrame: () => true,
      close: () => this.closeGeneration(generation),
    })
    if (!this.handlers) this.closeGeneration(generation)
  }

  private closeGeneration(generation: number): void {
    if (generation !== this.generation || !this.stream) return
    this.stream.close()
    this.stream = null
    this.handlers?.onClose()
    this.handlers = null
    void this.request('closeConnection', { generation }).catch(() => {})
    this.options.onStatusChange('error', 'Disconnected; reconnect manually')
  }

  close(): void {
    this.closed = true
    clearTimeout(this.startup)
    this.stream?.close()
    this.handlers?.onClose()
    this.handlers = null
    for (const request of this.pending.values()) request.reject(new Error('Sharing revoked'))
    this.pending.clear()
    this.port?.disconnect()
    this.port = null
    this.url = ''
  }
}
