import { ConfigurationError, mapURL } from './config.js'

export const MAX_MAP_BYTES = 1024 * 1024
export type DERPNode = {
  Name: string
  RegionID: number
  HostName: string
  DERPPort: number
  IPv4?: string
  IPv6?: string
}
export type DERPRegion = { RegionID: number; RegionCode: string; RegionName: string; Nodes: DERPNode[] }
export type DERPMap = { Regions: Record<string, DERPRegion> }
export type FrozenMap = { derpMapURL: string; derpMapSha256: string; regionId: number; mapJSON: string; map: DERPMap }
const invalid = () => new ConfigurationError('MAP_INVALID', 'Map contains invalid or unsupported relay configuration')
const object = (v: any): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)
const regionID = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0 && Number(v) <= 2147483647
function hostname(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length <= 253 &&
    v.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
  )
}
function ipHint(value: unknown, ipv6: boolean): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string') throw invalid()
  if (value === 'none') return value // Tailscale's documented disabled-family sentinel.
  if (ipv6) {
    try {
      if (!value.includes(':') || new URL(`https://[${value}]/`).hostname === '') throw invalid()
    } catch {
      throw invalid()
    }
  } else if (
    !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value) ||
    value.split('.').some((n) => Number(n) > 255)
  )
    throw invalid()
  return value
}
/** A routing allowlist, never a cast of untrusted JSON into Tailcat's richer schema. */
export function validateMap(value: unknown): DERPMap {
  if (!object(value) || !object(value.Regions)) throw invalid()
  const entries = Object.entries(value.Regions)
  if (!entries.length || entries.length > 64) throw invalid()
  const result: DERPMap = { Regions: {} }
  let total = 0
  const names = new Set<string>()
  for (const [id, region] of entries) {
    if (
      !object(region) ||
      !regionID(region.RegionID) ||
      String(region.RegionID) !== id ||
      !Array.isArray(region.Nodes) ||
      !region.Nodes.length
    )
      throw invalid()
    const nodes: DERPNode[] = []
    for (const node of region.Nodes) {
      if (
        ++total > 256 ||
        !object(node) ||
        node.RegionID !== region.RegionID ||
        typeof node.Name !== 'string' ||
        !node.Name ||
        new TextEncoder().encode(node.Name).length > 128 ||
        names.has(node.Name) ||
        !hostname(node.HostName)
      )
        throw invalid()
      names.add(node.Name)
      if (
        (node.InsecureForTests !== undefined && node.InsecureForTests !== false) ||
        (node.CertName !== undefined && node.CertName !== '') ||
        (node.STUNTestIP !== undefined && node.STUNTestIP !== '') ||
        (node.STUNOnly !== undefined && typeof node.STUNOnly !== 'boolean')
      )
        throw invalid()
      const port = node.DERPPort ?? 0
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw invalid()
      const IPv4 = ipHint(node.IPv4, false),
        IPv6 = ipHint(node.IPv6, true)
      if (node.STUNOnly) continue
      nodes.push({
        Name: node.Name,
        RegionID: region.RegionID,
        HostName: node.HostName.toLowerCase(),
        DERPPort: port || 443,
        ...(IPv4 ? { IPv4 } : {}),
        ...(IPv6 ? { IPv6 } : {}),
      })
    }
    // Only these fields reach either runtime. STUN, arbitrary metadata, test
    // fields and future upstream routing extensions cannot expand authority.
    if (nodes.length) result.Regions[id] = { RegionID: region.RegionID, RegionCode: id, RegionName: id, Nodes: nodes }
  }
  if (!Object.keys(result.Regions).length) throw invalid()
  return result
}
export async function freezeMap(
  bytes: Uint8Array,
  url: string,
  options: { expectedHash?: string; regionId?: number } = {},
): Promise<FrozenMap> {
  if (!bytes.length || bytes.length > MAX_MAP_BYTES)
    throw new ConfigurationError('MAP_TOO_LARGE', 'Map must contain 1 byte through 1 MiB')
  let mapJSON: string, map: DERPMap
  try {
    // Preserve BOM bytes so JSON rejects them consistently with the native
    // parser instead of silently changing the bytes bound by the descriptor.
    mapJSON = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    map = validateMap(JSON.parse(mapJSON))
  } catch {
    throw invalid()
  }
  const derpMapSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
  if (options.expectedHash && options.expectedHash !== derpMapSha256)
    throw new ConfigurationError(
      'MAP_CHANGED',
      'Map changed; Stop and Start sharing again, then copy new connection information',
    )
  const regionId = options.regionId ?? Math.min(...Object.keys(map.Regions).map(Number))
  if (!regionID(regionId) || !map.Regions[String(regionId)])
    throw new ConfigurationError('REGION_MISMATCH', 'Selected region is not in this map')
  return { derpMapURL: mapURL(url), derpMapSha256, regionId, mapJSON, map }
}
export async function fetchDERPMap(
  url: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch; expectedHash?: string; regionId?: number } = {},
): Promise<FrozenMap> {
  const normalized = mapURL(url)
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancelled = new Promise<never>((_, reject) => {
    abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
  })
  const cancel = () => abort.abort(new ConfigurationError('SHARE_REVOKED', 'Sharing or connection was cancelled'))
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  timer = setTimeout(
    () =>
      abort.abort(
        new ConfigurationError('MAP_TIMEOUT', 'Selected map did not respond within 10 seconds; retry explicitly'),
      ),
    10_000,
  )
  const work = async () => {
    abort.signal.throwIfAborted()
    const response = await (options.fetch ?? fetch)(normalized, {
      signal: abort.signal,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
    })
    abort.signal.throwIfAborted()
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400) || response.redirected)
      throw new ConfigurationError('MAP_REDIRECT', 'Map redirects are unsupported; configure its final HTTPS URL')
    if (!response.ok || !response.body)
      throw new ConfigurationError('MAP_UNAVAILABLE', 'Selected map is unavailable; check network, TLS and permissions')
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const { value, done } = await reader.read()
      abort.signal.throwIfAborted()
      if (done) break
      if ((length += value.length) > MAX_MAP_BYTES) throw new ConfigurationError('MAP_TOO_LARGE', 'Map exceeds 1 MiB')
      chunks.push(value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return freezeMap(bytes, normalized, options)
  }
  try {
    return await Promise.race([work(), cancelled])
  } catch (e) {
    if (e instanceof ConfigurationError) throw e
    throw new ConfigurationError('MAP_UNAVAILABLE', 'Selected map is unavailable; check network, TLS and permissions')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
    void reader?.cancel().catch(() => {})
    abort.abort()
  }
}
