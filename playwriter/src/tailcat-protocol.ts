/** PWTC1 framing shared by the browser worker and controller. No hosted envelope. */
export const PUBLIC_DERP_MAP = 'https://tailcat.dev/derpmap.json'
export const MAX_RECORD = 16 * 1024 * 1024
export const MAX_PENDING = 32 * 1024 * 1024
export const MAX_CHUNK = 64 * 1024
const PREFACE = new Uint8Array([80, 87, 84, 67, 49, 10])
const encoder = new TextEncoder()

function validate(json: string): void {
  const message = JSON.parse(json)
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid extension record')
  if (typeof message.method === 'string' && message.method.length > 0) {
    if (message.id !== undefined && !Number.isSafeInteger(message.id)) throw new Error('Invalid extension request id')
    if (
      message.params !== undefined &&
      (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))
    ) {
      throw new Error('Invalid extension parameters')
    }
    if (message.method === 'forwardCDPCommand' && typeof message.params?.method !== 'string')
      throw new Error('Invalid CDP command')
    if (message.method === 'forwardCDPEvent' && typeof message.params?.method !== 'string')
      throw new Error('Invalid CDP event')
    return
  }
  if (!Number.isSafeInteger(message.id) || (!('result' in message) && typeof message.error !== 'string')) {
    throw new Error('Invalid extension response')
  }
}

export class FramedStream {
  private preface = 0
  private header = new Uint8Array(4)
  private headerUsed = 0
  private body: Uint8Array | null = null
  private bodyUsed = 0
  private pending = 0
  private writes: Promise<void> = Promise.resolve()
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  readonly ready: Promise<void>
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void

  constructor(
    private options: {
      write(bytes: Uint8Array): Promise<void>
      onMessage(json: string): Promise<void>
      onError(error: Error): void
      handshakeMs?: number
      handshakeStartsOnRead?: boolean
    },
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    void this.ready.catch(() => {})
  }

  async start(): Promise<void> {
    if (!this.options.handshakeStartsOnRead) this.startHandshakeTimer()
    try {
      await this.options.write(PREFACE)
    } catch {
      this.fail(new Error('Preface write failed'))
    }
  }

  async receive(chunk: Uint8Array): Promise<void> {
    if (this.stopped) throw new Error('Connection generation is closed')
    if (chunk.length > MAX_CHUNK) {
      this.fail(new Error('Raw chunk exceeds 64 KiB'))
      return
    }
    try {
      if (this.options.handshakeStartsOnRead && !this.timer && this.preface === 0 && chunk.length)
        this.startHandshakeTimer()
      let offset = 0
      while (offset < chunk.length && !this.stopped) {
        if (this.preface < PREFACE.length) {
          if (chunk[offset++] !== PREFACE[this.preface++]) throw new Error('Protocol preface mismatch')
          if (this.preface === PREFACE.length) {
            clearTimeout(this.timer)
            this.resolveReady()
          }
          continue
        }
        if (!this.body) {
          this.header[this.headerUsed++] = chunk[offset++]
          if (this.headerUsed < 4) continue
          const length = new DataView(this.header.buffer).getUint32(0)
          if (length < 1 || length > MAX_RECORD) throw new Error('Record length outside 1..16777216')
          if (this.pending + length * 2 + MAX_CHUNK > MAX_PENDING) throw new Error('Pending data exceeds 32 MiB')
          this.body = new Uint8Array(length)
          this.bodyUsed = 0
        }
        const take = Math.min(chunk.length - offset, this.body.length - this.bodyUsed)
        this.body.set(chunk.subarray(offset, offset + take), this.bodyUsed)
        offset += take
        this.bodyUsed += take
        if (this.bodyUsed === this.body.length) {
          const json = new TextDecoder('utf-8', { fatal: true }).decode(this.body)
          validate(json)
          await this.options.onMessage(json)
          this.body = null
          this.headerUsed = 0
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Invalid record'))
    }
  }

  send(json: string): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Connection generation is closed'))
    try {
      validate(json)
    } catch (error) {
      this.fail(error as Error)
      return Promise.reject(error)
    }
    const bytes = encoder.encode(json)
    // Reserve both encoded copies plus the native/bridge chunk before retaining work.
    const reserved = bytes.length * 2 + 4 + MAX_CHUNK
    if (
      !bytes.length ||
      bytes.length > MAX_RECORD ||
      this.pending + reserved + (this.body?.length ?? 0) * 2 > MAX_PENDING
    ) {
      const error = new Error('Record or pending data limit exceeded')
      this.fail(error)
      return Promise.reject(error)
    }
    this.pending += reserved
    const work = this.writes
      .then(async () => {
        await this.ready
        if (this.stopped) throw new Error('Connection generation is closed')
        const header = new Uint8Array(4)
        new DataView(header.buffer).setUint32(0, bytes.length)
        await this.options.write(header)
        for (let i = 0; i < bytes.length; i += MAX_CHUNK) {
          if (this.stopped) throw new Error('Connection generation is closed')
          await this.options.write(bytes.subarray(i, i + MAX_CHUNK))
        }
      })
      .finally(() => {
        this.pending -= reserved
      })
    this.writes = work.catch(() => {})
    return work.catch((error) => {
      this.fail(error)
      throw error
    })
  }

  end(): void {
    this.fail(
      new Error(
        this.body || this.headerUsed || this.preface < 6
          ? 'Truncated protocol stream'
          : 'Application stream closed; outcome unknown',
      ),
    )
  }
  close(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.rejectReady(new Error('Connection generation is closed'))
    this.body = null
  }
  private fail(error: Error): void {
    if (!this.stopped) {
      this.close()
      this.options.onError(error)
    }
  }
  private startHandshakeTimer(): void {
    this.timer = setTimeout(
      () => this.fail(new Error('Preface exchange timed out')),
      this.options.handshakeMs ?? 10_000,
    )
  }
}
