import { expect, it, vi } from 'vitest'
import { ProfileStore, mapURL, findProfile } from './config.js'
import { fetchDERPMap } from './map.js'
import { descriptorConfiguration, validateSessionHello } from './descriptor.js'
import { readFileSync } from 'node:fs'
import { validateMap } from './map.js'
const mapCases: Array<{ name: string; body: unknown; valid: boolean }> = JSON.parse(
  readFileSync(new URL('./map-cases.json', import.meta.url), 'utf8'),
)

it('does not let an editable name shadow the authoritative ID of another server', () => {
  const id = '1'.repeat(32),
    other = '2'.repeat(32)
  const profiles = {
    v: 1 as const,
    revision: 0,
    selectedProfileId: id,
    profiles: [
      { id: other, name: id, derpMapURL: 'https://public.example/map', revision: 0 },
      { id, name: 'Lab', derpMapURL: 'https://lab.example/map', revision: 0 },
    ],
  }
  expect(findProfile(profiles, id).derpMapURL).toBe('https://lab.example/map')
  expect(findProfile(profiles).id).toBe(id)
})

it.each(mapCases)('shares browser/native validation: $name', ({ body, valid }) => {
  if (!valid) expect(() => validateMap(body)).toThrow('MAP_INVALID')
  else expect(validateMap(body).Regions['900'].Nodes[0]).toMatchObject({ HostName: 'relay-a.example', DERPPort: 8443 })
})

it('keeps saved selection and removal across reopening without recreating Public', async () => {
  let saved: unknown
  const storage = {
    read: async () => saved,
    write: async (value: unknown) => {
      saved = structuredClone(value)
    },
  }
  const profiles = new ProfileStore(storage)
  const initial = await profiles.read()
  expect(initial.profiles.map((p) => p.name)).toEqual(['Public'])
  const added = await profiles.update({
    action: 'add',
    name: 'Lab',
    derpMapURL: 'https://LAB.example:443/map.json',
    expectedRevision: initial.revision,
  })
  const lab = added.profiles.find((p) => p.name === 'Lab')!
  const selected = await profiles.update({ action: 'select', id: lab.id, expectedRevision: added.revision })
  const removed = await profiles.update({ action: 'remove', id: lab.id, expectedRevision: selected.revision })
  expect(removed.selectedProfileId).toBeNull()
  const empty = await profiles.update({
    action: 'remove',
    id: initial.profiles[0].id,
    expectedRevision: removed.revision,
  })
  expect((await new ProfileStore(storage).read()).profiles).toEqual([])
  expect(empty.selectedProfileId).toBeNull()
})

export const mapFixture = JSON.stringify({
  Regions: {
    '900': {
      RegionID: 900,
      RegionCode: 'lab',
      RegionName: 'Lab',
      Nodes: [{ Name: 'lab1', RegionID: 900, HostName: 'relay.example', DERPPort: 8443 }],
    },
  },
})

it('uses exactly the selected map and preserves a nondefault relay port', async () => {
  const requests: string[] = []
  const fetcher: typeof fetch = async (url) => {
    requests.push(String(url))
    return new Response(mapFixture)
  }
  const map = await fetchDERPMap('https://map.example/map.json', { fetch: fetcher })
  expect(map.regionId).toBe(900)
  expect(map.map.Regions['900'].Nodes[0].DERPPort).toBe(8443)
  expect(map.mapJSON).toBe(mapFixture)
  expect(requests).toEqual(['https://map.example/map.json'])
  await expect(
    fetchDERPMap('https://map.example/map.json', { fetch: fetcher, expectedHash: '0'.repeat(64) }),
  ).rejects.toThrow('MAP_CHANGED')
})

it.each([
  'relay.example',
  'http://relay.example/map',
  'wss://relay.example/derp',
  'https://a.example/map?q=secret',
  'https://user@a.example/map',
  'https://a.example/map#',
  'https://a.example/%qq',
  'https://a.example\\evil',
])('rejects ambiguous or unsafe map URL %s', (url) => {
  expect(() => mapURL(url)).toThrow('MAP_URL_INVALID')
})

it('does not reset corrupt storage or accept a stale competing selection', async () => {
  const corrupt = new ProfileStore({
    read: async () => ({}),
    write: async () => {
      throw new Error('must not write')
    },
  })
  await expect(corrupt.read()).rejects.toThrow('CONFIG_INVALID')
  let saved: unknown
  const store = new ProfileStore({
    read: async () => saved,
    write: async (v) => {
      saved = v
    },
  })
  const initial = await store.read()
  const first = store.update({ action: 'select', id: null, expectedRevision: initial.revision })
  const second = store.update({ action: 'select', id: initial.selectedProfileId, expectedRevision: initial.revision })
  await first
  await expect(second).rejects.toThrow('CONFIG_CONFLICT')
  expect((await store.read()).selectedProfileId).toBeNull()
})

it('times out a stalled body without fetching any fallback', async () => {
  vi.useFakeTimers()
  try {
    const requests: string[] = []
    const fetcher: typeof fetch = async (url) => {
      requests.push(String(url))
      return new Response(new ReadableStream({ start() {} }))
    }
    const result = expect(fetchDERPMap('https://map.example/map', { fetch: fetcher })).rejects.toThrow('MAP_TIMEOUT')
    await vi.advanceTimersByTimeAsync(10_001)
    await result
    expect(requests).toEqual(['https://map.example/map'])
  } finally {
    vi.useRealTimers()
  }
})

it.each([
  ['empty map', { Regions: {} }],
  ['null region', { Regions: { '900': null } }],
  ['missing region id', { Regions: { '900': { Nodes: [] } } }],
  [
    'insecure node',
    {
      Regions: {
        '900': {
          RegionID: 900,
          Nodes: [{ Name: 'x', RegionID: 900, HostName: 'relay.example', InsecureForTests: true }],
        },
      },
    },
  ],
  [
    'certificate override',
    {
      Regions: {
        '900': {
          RegionID: 900,
          Nodes: [{ Name: 'x', RegionID: 900, HostName: 'relay.example', CertName: 'other.example' }],
        },
      },
    },
  ],
  [
    'duplicate node',
    {
      Regions: {
        '900': { RegionID: 900, Nodes: Array(2).fill({ Name: 'x', RegionID: 900, HostName: 'relay.example' }) },
      },
    },
  ],
])('fails selected configuration without fallback for %s', async (_name, body) => {
  const urls: string[] = []
  await expect(
    fetchDERPMap('https://map.example/map', {
      fetch: async (u) => {
        urls.push(String(u))
        return new Response(JSON.stringify(body))
      },
    }),
  ).rejects.toThrow('MAP_INVALID')
  expect(urls).toEqual(['https://map.example/map'])
})

it.each([301, 302, 307, 308])('refuses redirect %s without contacting its destination', async (status) => {
  const requests: string[] = []
  await expect(
    fetchDERPMap('https://map.example/map', {
      fetch: async (u, init) => {
        requests.push(String(u))
        expect(init?.redirect).toBe('manual')
        expect(init?.credentials).toBe('omit')
        return new Response('', { status, headers: { location: 'https://tailcat.dev/derpmap.json' } })
      },
    }),
  ).rejects.toThrow('MAP_REDIRECT')
  expect(requests).toEqual(['https://map.example/map'])
})

it('rejects mismatching explicit server and forged authenticated session metadata', () => {
  const descriptor = {
    v: 2 as const,
    transport: 'playwriter-tailcat' as const,
    addr: 'tc' + 'a'.repeat(20),
    port: 1 as const,
    shareId: '1'.repeat(32),
    derpMapURL: 'https://map.example/map',
    derpMapSha256: '2'.repeat(64),
    regionId: 900,
  }
  expect(descriptorConfiguration(descriptor)).toEqual(descriptor)
  expect(() => descriptorConfiguration(descriptor, 'https://other.example/map')).toThrow('SERVER_MISMATCH')
  expect(() => validateSessionHello(descriptor, undefined)).toThrow('SESSION_MISMATCH')
  expect(() =>
    validateSessionHello(descriptor, {
      descriptorVersion: 2,
      ...descriptor,
      shareId: '3'.repeat(32),
      connectionGeneration: 1,
    }),
  ).toThrow('SESSION_MISMATCH')
  expect(validateSessionHello(descriptor, { descriptorVersion: 2, ...descriptor, connectionGeneration: 7 })).toBe(7)
})

it('accepts normalized HTTPS scheme but rejects port zero', () => {
  expect(mapURL('HTTPS://MAP.example:443/map')).toBe('https://map.example/map')
  expect(() => mapURL('https://map.example:0/map')).toThrow('MAP_URL_INVALID')
})

it.each([
  ['truncated JSON', () => new Response('{"Regions":'), 'MAP_INVALID'],
  ['invalid UTF8', () => new Response(new Uint8Array([255])), 'MAP_INVALID'],
  ['UTF8 BOM', () => new Response(new Uint8Array([239, 187, 191, 123, 125])), 'MAP_INVALID'],
  ['oversized body', () => new Response(' '.repeat(1024 * 1024 + 1)), 'MAP_TOO_LARGE'],
  ['HTTP failure', () => new Response('unavailable', { status: 503 }), 'MAP_UNAVAILABLE'],
] as const)('bounds and rejects %s without another request', async (_name, response, code) => {
  const fetcher = vi.fn(async () => response())
  await expect(fetchDERPMap('https://map.example/map', { fetch: fetcher })).rejects.toThrow(code)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('does not rescue a failed warm map fetch or a missing selected region', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(mapFixture))
    .mockRejectedValueOnce(new TypeError('TLS or network failure'))
  await fetchDERPMap('https://map.example/map', { fetch: fetcher })
  await expect(fetchDERPMap('https://map.example/map', { fetch: fetcher })).rejects.toThrow('MAP_UNAVAILABLE')
  await expect(
    fetchDERPMap('https://map.example/map', { regionId: 901, fetch: async () => new Response(mapFixture) }),
  ).rejects.toThrow('REGION_MISMATCH')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('rejects a cancelled fetch even if its valid body arrives after revocation', async () => {
  const abort = new AbortController()
  let release!: (response: Response) => void
  const response = new Promise<Response>((resolve) => {
    release = resolve
  })
  const attempt = fetchDERPMap('https://map.example/map', { signal: abort.signal, fetch: async () => response })
  const rejected = expect(attempt).rejects.toThrow('SHARE_REVOKED')
  abort.abort()
  release(new Response(mapFixture))
  await rejected
})
