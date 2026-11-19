// Dedicated test-build race controls; production call sites are compiled out.
const names = new Set([
  'anchor-attach',
  'create-tab',
  'dispatch',
  'response',
  'startup-before-listen',
  'startup-after-descriptor',
  'preface',
  'transfer',
])
const mapFixtures = new Map<string, { body: string; status?: number; hang?: boolean }>()
const mapRequests: string[] = []
export function setTailcatMapFixture(url: string, fixture: { body: string; status?: number; hang?: boolean }): void {
  if (!import.meta.env.TESTING || !url.startsWith('https://') || fixture.body.length > 2 * 1024 * 1024)
    throw Error('Invalid test map')
  mapFixtures.set(url, fixture)
}
export function tailcatMapRequests(): string[] {
  return [...mapRequests]
}
export const tailcatMapFetch: typeof fetch = async (url, init) => {
  mapRequests.push(String(url))
  if (mapRequests.length > 128) mapRequests.shift()
  const fixture = mapFixtures.get(String(url))
  if (!fixture) return fetch(url, init)
  return new Response(fixture.hang ? new ReadableStream({ start() {} }) : fixture.body, {
    status: fixture.status ?? 200,
  })
}
const barriers = new Map<string, { promise: Promise<void>; release(): void; blocked: number; method?: string }>()
export function armTailcatBarrier(name: string, method?: string): void {
  if (!import.meta.env.TESTING || !names.has(name) || barriers.has(name)) throw Error('Invalid test barrier')
  let release = () => {}
  const promise = new Promise<void>((ok) => {
    release = ok
  })
  barriers.set(name, { promise, release, blocked: 0, method })
}
export async function waitTailcatBarrier(name: string, method?: string): Promise<void> {
  const barrier = barriers.get(name)
  if (!barrier || (barrier.method && barrier.method !== method)) return
  if (barrier.blocked) return
  barrier.blocked++
  await barrier.promise
}
export function releaseTailcatBarrier(name: string): void {
  const barrier = barriers.get(name)
  barriers.delete(name)
  barrier?.release()
}
export function tailcatBarrierStatus(name: string): { blocked: number } {
  return { blocked: barriers.get(name)?.blocked ?? 0 }
}
