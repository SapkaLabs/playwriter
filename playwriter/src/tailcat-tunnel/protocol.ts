/** PWTC1 framing shared by the browser worker and controller. No hosted envelope. */
export const PUBLIC_DERP_MAP = 'https://tailcat.dev/derpmap.json'
export const MAX_RECORD = 16 * 1024 * 1024
export const MAX_PENDING = 32 * 1024 * 1024
export const MAX_CHUNK = 64 * 1024
const PREFACE = new Uint8Array([80, 87, 84, 67, 49, 10])
const encoder = new TextEncoder()
/** One quota for all retained application copies at an endpoint. */
export class PendingDataBudget {
  private used = 0
  reserve(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.used + bytes > MAX_PENDING) {
      throw new Error('Pending data exceeds 32 MiB')
    }
    this.used += bytes
    let released = false
    return () => {
      if (!released) {
        this.used -= bytes
        released = true
      }
    }
  }
}

export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4
    if (code > 65535) i++
  }
  return bytes
}
export type FrameMetadata = {
  direction: 'read' | 'write'
  id?: number
  method?: string
  cdpMethod?: string
  bytes: number
}
function metadata(json: string, bytes: number, direction: 'read' | 'write'): FrameMetadata {
  const message = JSON.parse(json)
  return {
    direction,
    bytes,
    id: message.id,
    method: message.method,
    cdpMethod:
      typeof message.params?.method === 'string' &&
      message.params.method.length <= 128 &&
      /^(Target|Page|Runtime|DOM|Network|Input|Browser|Emulation|Storage|CSS|Debugger|Log|Accessibility)\.[A-Za-z]+$/.test(
        message.params?.method,
      )
        ? message.params.method
        : undefined,
  }
}
const METHODS = new Set([
  'forwardCDPCommand',
  'forwardCDPEvent',
  'hello',
  'ready',
  'ping',
  'pong',
  'log',
  'createInitialTab',
  'updateTabGroup',
  'closeTabsForKey',
  'ghost-browser',
  'setRecorderState',
  'getTabs',
  'switchToTab',
  'disconnectTab',
])

function validate(json: string): void {
  let message: any
  try {
    message = JSON.parse(json)
  } catch {
    throw new Error('Invalid extension JSON')
  }
  const object = (value: unknown) => Boolean(value && typeof value === 'object' && !Array.isArray(value))
  const strings = (value: Record<string, unknown>, keys: string[]) => {
    if (keys.some((key) => value[key] !== undefined && typeof value[key] !== 'string'))
      throw new Error('Invalid extension string field')
  }
  if (!object(message)) throw new Error('Invalid extension record')
  if (message.method !== undefined) {
    if (!METHODS.has(message.method)) throw new Error('Unsupported extension method')
    const notification = ['forwardCDPEvent', 'hello', 'ready', 'ping', 'pong', 'log', 'setRecorderState'].includes(
      message.method,
    )
    if (notification ? message.id !== undefined : !Number.isSafeInteger(message.id))
      throw new Error('Invalid extension request id')
    if (message.params !== undefined && !object(message.params)) {
      throw new Error('Invalid extension parameters')
    }
    const params = message.params
    const required = (...keys: string[]) => {
      if (!object(params) || keys.some((key) => params[key] === undefined))
        throw new Error('Missing extension parameters')
    }
    switch (message.method) {
      case 'forwardCDPCommand':
      case 'forwardCDPEvent':
        required('method')
        strings(params, ['method', 'sessionId', 'source', 'tabGroup', 'tabGroupKey', 'tabGroupColor', 'ownerKey'])
        if (
          !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(params.method) ||
          (params.params !== undefined && !object(params.params))
        )
          throw new Error('Invalid CDP envelope')
        break
      case 'hello':
        required()
        strings(params, ['browser', 'email', 'id', 'installId', 'version'])
        if (params.remote !== undefined && typeof params.remote !== 'boolean')
          throw new Error('Invalid hello remote field')
        if (
          params.capabilities !== undefined &&
          (!Array.isArray(params.capabilities) ||
            params.capabilities.some((value: unknown) => typeof value !== 'string'))
        )
          throw new Error('Invalid hello capabilities')
        break
      case 'log':
        required('level', 'args')
        if (
          !['log', 'debug', 'info', 'warn', 'error'].includes(params.level) ||
          !Array.isArray(params.args) ||
          params.args.some((value: unknown) => typeof value !== 'string')
        )
          throw new Error('Invalid extension log')
        break
      case 'setRecorderState':
        required('recording')
        if (typeof params.recording !== 'boolean') throw new Error('Invalid recorder state')
        break
      case 'updateTabGroup':
        required('from', 'to')
        strings(params, ['from', 'to', 'key', 'color'])
        break
      case 'closeTabsForKey':
        required('key')
        strings(params, ['key'])
        break
      case 'createInitialTab':
        if (params) strings(params, ['tabGroup', 'tabGroupKey', 'tabGroupColor'])
        break
      case 'ghost-browser':
        required('namespace', 'method', 'args')
        if (
          !['ghostPublicAPI', 'ghostProxies', 'projects'].includes(params.namespace) ||
          typeof params.method !== 'string' ||
          !Array.isArray(params.args)
        )
          throw new Error('Invalid browser command')
        break
    }
    return
  }
  // Void extension responses legitimately contain only their request id.
  if (!Number.isSafeInteger(message.id) || (message.error !== undefined && typeof message.error !== 'string')) {
    throw new Error('Invalid extension response')
  }
}

export class FramedStream {
  private preface = 0
  private header = new Uint8Array(4)
  private headerUsed = 0
  private body: Uint8Array | null = null
  private bodyUsed = 0
  private releaseBody: (() => void) | undefined
  private readonly budget: PendingDataBudget
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
      onFrame?(frame: FrameMetadata): void
      beforeWriteRecord?(frame: FrameMetadata): Promise<void>
      budget?: PendingDataBudget
    },
  ) {
    this.budget = options.budget ?? new PendingDataBudget()
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    void this.ready.catch(() => {})
  }

  async start(): Promise<void> {
    if (!this.options.handshakeStartsOnRead && this.preface < PREFACE.length) this.startHandshakeTimer()
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
          this.releaseBody = this.budget.reserve(length)
          this.body = new Uint8Array(length)
          this.bodyUsed = 0
        }
        const take = Math.min(chunk.length - offset, this.body.length - this.bodyUsed)
        this.body.set(chunk.subarray(offset, offset + take), this.bodyUsed)
        offset += take
        this.bodyUsed += take
        if (this.bodyUsed === this.body.length) {
          const releaseJSON = this.budget.reserve(this.body.length)
          try {
            const json = new TextDecoder('utf-8', { fatal: true }).decode(this.body)
            validate(json)
            this.options.onFrame?.(metadata(json, this.body.length, 'read'))
            this.body = null
            this.releaseBody?.()
            this.releaseBody = undefined
            this.headerUsed = 0
            await this.options.onMessage(json)
          } finally {
            releaseJSON()
          }
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Invalid record'))
    }
  }

  send(json: string): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Connection generation is closed'))
    let releaseBytes: (() => void) | undefined
    let releaseJSON: (() => void) | undefined
    try {
      const length = utf8Length(json)
      if (!length || length > MAX_RECORD) throw new Error('Record length outside 1..16777216')
      // Reserve before encoding/retaining the next full copy.
      releaseJSON = this.budget.reserve(length)
      releaseBytes = this.budget.reserve(length)
      validate(json)
      const bytes = encoder.encode(json)
      releaseJSON()
      releaseJSON = undefined
      return this.queueRecord(bytes, releaseBytes)
    } catch (error) {
      releaseJSON?.()
      releaseBytes?.()
      this.fail(error as Error)
      return Promise.reject(error)
    }
  }

  /** Takes ownership of a raw WS record, avoiding another full encoded copy. */
  sendRecord(bytes: Uint8Array): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('Connection generation is closed'))
    let releaseBytes: (() => void) | undefined
    let releaseJSON: (() => void) | undefined
    try {
      if (!bytes.length || bytes.length > MAX_RECORD) throw new Error('Record length outside 1..16777216')
      releaseBytes = this.budget.reserve(bytes.length)
      releaseJSON = this.budget.reserve(bytes.length)
      validate(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      releaseJSON()
      releaseJSON = undefined
      return this.queueRecord(bytes, releaseBytes)
    } catch (error) {
      releaseJSON?.()
      releaseBytes?.()
      this.fail(error as Error)
      return Promise.reject(error)
    }
  }

  private queueRecord(bytes: Uint8Array, releaseBytes: () => void): Promise<void> {
    const work = this.writes
      .then(async () => {
        await this.ready
        if (this.stopped) throw new Error('Connection generation is closed')
        const header = new Uint8Array(4)
        new DataView(header.buffer).setUint32(0, bytes.length)
        const frame = metadata(new TextDecoder().decode(bytes), bytes.length, 'write')
        await this.options.beforeWriteRecord?.(frame)
        if (this.stopped) throw new Error('Connection generation is closed')
        this.options.onFrame?.(frame)
        await this.options.write(header)
        for (let i = 0; i < bytes.length; i += MAX_CHUNK) {
          if (this.stopped) throw new Error('Connection generation is closed')
          const chunk = bytes.subarray(i, i + MAX_CHUNK)
          const releaseBridge = this.budget.reserve(chunk.length * 4)
          try {
            await this.options.write(chunk)
          } finally {
            releaseBridge()
          }
        }
      })
      .finally(() => {
        releaseBytes()
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
    this.releaseBody?.()
    this.releaseBody = undefined
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
