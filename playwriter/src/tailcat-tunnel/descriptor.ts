import { ConfigurationError, mapURL } from './config.js'
import { PUBLIC_DERP_MAP } from './protocol.js'

export type DescriptorV1 = {
  v: 1
  transport: 'playwriter-tailcat'
  addr: string
  port: 1
  relayMode: 'public'
  derpMapURL: string
}
export type DescriptorV2 = {
  v: 2
  transport: 'playwriter-tailcat'
  addr: string
  port: 1
  shareId: string
  derpMapURL: string
  derpMapSha256: string
  regionId: number
}
export type Descriptor = DescriptorV1 | DescriptorV2
export function descriptorConfiguration(value: unknown, assertedURL?: string): Descriptor {
  const d = value as Descriptor
  if (!d || (d.v !== 1 && d.v !== 2))
    throw new ConfigurationError('DESCRIPTOR_VERSION', 'Unsupported descriptor version; update the controller')
  if (
    JSON.stringify(value).length > 16384 ||
    d.transport !== 'playwriter-tailcat' ||
    d.port !== 1 ||
    typeof d.addr !== 'string' ||
    !/^tc[A-Za-z0-9_-]{20,8192}$/.test(d.addr)
  )
    throw new ConfigurationError('DESCRIPTOR_INVALID', 'Invalid connection information')
  if (d.v === 1) {
    if (d.relayMode !== 'public' || d.derpMapURL !== PUBLIC_DERP_MAP)
      throw new ConfigurationError('DESCRIPTOR_INVALID', 'Unsupported public Tailcat descriptor')
  } else if (
    !/^[a-f0-9]{32}$/.test(d.shareId) ||
    !/^[a-f0-9]{64}$/.test(d.derpMapSha256) ||
    !Number.isInteger(d.regionId) ||
    d.regionId <= 0 ||
    d.regionId > 2147483647 ||
    d.derpMapURL !== mapURL(d.derpMapURL)
  ) {
    throw new ConfigurationError('DESCRIPTOR_INVALID', 'Invalid connection configuration')
  }
  if (assertedURL !== undefined && mapURL(assertedURL) !== d.derpMapURL)
    throw new ConfigurationError(
      'SERVER_MISMATCH',
      'Selected server conflicts with descriptor; use matching connection information',
    )
  return d
}
export function validateSessionHello(d: DescriptorV2, value: unknown): number {
  const hello = value as Record<string, unknown> | undefined
  if (
    !hello ||
    hello.descriptorVersion !== 2 ||
    hello.shareId !== d.shareId ||
    hello.derpMapURL !== d.derpMapURL ||
    hello.derpMapSha256 !== d.derpMapSha256 ||
    hello.regionId !== d.regionId ||
    !Number.isSafeInteger(hello.connectionGeneration) ||
    Number(hello.connectionGeneration) < 1
  )
    throw new ConfigurationError('SESSION_MISMATCH', 'Authenticated session does not match connection information')
  return Number(hello.connectionGeneration)
}
