import { FramedStream, PendingDataBudget, utf8Length, MAX_CHUNK } from 'playwriter/src/tailcat-tunnel/protocol'
import type { RemoteTunnelOptions, TunnelConnectionHandlers } from '../remote-tunnel'
import { waitTailcatBarrier, tailcatMapFetch } from './test-controls'
import { fetchDERPMap } from 'playwriter/src/tailcat-tunnel/map'
import { configurationError, type ServerProfile } from 'playwriter/src/tailcat-tunnel/config'
import type { DescriptorV2 } from 'playwriter/src/tailcat-tunnel/descriptor'

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
    return this.request(action === 'cut' ? 'testCut' : action === 'workerLoss' ? 'testKill' : 'testDispose', data)
  }
  private port: chrome.runtime.Port | null = null
  private closed = false
  private serial = 0
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  private stream: FramedStream | null = null
  private startup: ReturnType<typeof setTimeout> | undefined
  private handlers: TunnelConnectionHandlers | null = null
  private generation = 0
  private abort = new AbortController()
  private descriptor: DescriptorV2 | null = null
  private relayAvailable = false
  private resolveDisposed!: () => void
  private rejectDisposed!: (error: Error) => void
  readonly disposed = new Promise<void>((resolve, reject) => {
    this.resolveDisposed = resolve
    this.rejectDisposed = reject
  })

  constructor(
    private options: RemoteTunnelOptions & {
      profile?: ServerProfile
      deadline?: number
      ensureOffscreen(): Promise<void>
      onFatal(reason: string): void
    },
  ) {
    void this.disposed.catch(() => {})
  }

  start(): void {
    void this.open().catch((error) => {
      if (!this.closed) this.options.onFatal(configurationError(error) + '; sharing stopped')
    })
  }

  private async open(): Promise<void> {
    this.startup = setTimeout(
      () => this.options.onFatal('STARTUP_TIMEOUT: sharing stopped'),
      Math.max(1, (this.options.deadline ?? Date.now() + 60_000) - Date.now()),
    )
    if (import.meta.env.TESTING) await waitTailcatBarrier('startup-before-listen')
    if (this.closed) return
    if (!this.options.profile) throw new Error('No selected profile')
    const configuration = await fetchDERPMap(this.options.profile.derpMapURL, {
      signal: this.abort.signal,
      fetch: import.meta.env.TESTING ? tailcatMapFetch : undefined,
    })
    if (this.closed) return
    await this.options.ensureOffscreen()
    if (this.closed) return
    const port = chrome.runtime.connect({ name: 'playwriter-tailcat' })
    this.port = port
    port.onDisconnect.addListener(() => {
      this.resolveDisposed()
      if (!this.closed) this.options.onFatal('TRANSPORT_UNAVAILABLE: Transport owner lost; sharing stopped')
    })
    port.onMessage.addListener((data) => {
      if (data.stopped) {
        this.resolveDisposed()
        return
      }
      if (this.closed) return
      if (typeof data.relayAvailable === 'boolean') {
        this.relayAvailable = data.relayAvailable
        if (this.relayAvailable && this.descriptor) {
          clearTimeout(this.startup)
          this.options.onStatusChange('online')
        } else if (!this.relayAvailable)
          this.options.onStatusChange('error', 'Selected relay unavailable; retrying this region only')
        return
      }
      if (data.trace) {
        this.record(data.trace)
        return
      }
      if (data.fatal) {
        this.options.onFatal('TRANSPORT_UNAVAILABLE: Transport runtime lost; sharing stopped')
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
    const { addr } = await this.request('start', { assetRoot: chrome.runtime.getURL('tailcat/'), configuration })
    if (this.closed) return
    this.descriptor = {
      v: 2,
      transport: 'playwriter-tailcat',
      addr,
      port: 1,
      shareId: this.options.tunnelId,
      derpMapURL: configuration.derpMapURL,
      derpMapSha256: configuration.derpMapSha256,
      regionId: configuration.regionId,
    }
    this.url = JSON.stringify(this.descriptor)
    if (import.meta.env.TESTING) await waitTailcatBarrier('startup-after-descriptor')
    if (this.closed) return
    if (this.relayAvailable) {
      clearTimeout(this.startup)
      this.options.onStatusChange('online')
    }
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
    const budget = new PendingDataBudget()
    const stream = new FramedStream({
      budget,
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
        if (import.meta.env.TESTING && bytes.length === MAX_CHUNK) await waitTailcatBarrier('transfer')
      },
      onMessage: async (json) => {
        if (this.closed || this.stream !== stream) return
        const release = budget.reserve(utf8Length(json))
        try {
          const dispatched = this.handlers?.onMessage(json)
          void Promise.resolve(dispatched)
            .finally(release)
            .catch(() => this.closeGeneration(generation))
        } catch (error) {
          release()
          throw error
        }
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
    if (import.meta.env.TESTING) await waitTailcatBarrier('preface')
    if (this.closed || this.stream !== stream) return
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
        const message = JSON.parse(json)
        if (message.method === 'hello' && this.descriptor) {
          const { shareId, derpMapURL, derpMapSha256, regionId } = this.descriptor
          message.params.tailcatSession = {
            descriptorVersion: 2,
            shareId,
            derpMapURL,
            derpMapSha256,
            regionId,
            connectionGeneration: generation,
          }
          json = JSON.stringify(message)
        }
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
    if (this.closed) return
    this.closed = true
    this.abort.abort()
    clearTimeout(this.startup)
    this.stream?.close()
    this.handlers?.onClose()
    this.handlers = null
    for (const request of this.pending.values()) request.reject(new Error('Sharing revoked'))
    this.pending.clear()
    const port = this.port
    if (port) {
      const timer = setTimeout(
        () => this.rejectDisposed(new Error('Transport cleanup failed; reload the extension')),
        3000,
      )
      void this.disposed
        .finally(() => {
          clearTimeout(timer)
          port.disconnect()
        })
        .catch(() => {})
      try {
        port.postMessage({ action: 'stop' })
      } catch {
        this.resolveDisposed()
      }
    } else this.resolveDisposed()
    this.port = null
    this.url = ''
    this.descriptor = null
  }
}
