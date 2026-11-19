import { validateProfiles, type Profiles } from 'playwriter/src/tailcat-tunnel/config'
import { PUBLIC_DERP_MAP } from 'playwriter/src/tailcat-tunnel/protocol'

export const CONNECTION_SETTINGS_PAGE = 'src/connection-settings.html'
const CONNECTION_SETTINGS_KEY = 'playwriterConnectionSettings'
export const TAILCAT_PROFILES_KEY = 'tailcatProfiles'

export type Route = 'local' | 'hosted' | 'tailcat'
export type RemoteRoute = Exclude<Route, 'local'>

export function isRoute(route: unknown): route is Route {
  return route === 'local' || route === 'hosted' || route === 'tailcat'
}

export type ConnectionRequest =
  | { kind: 'status' }
  | { kind: 'select'; route: Route }
  | { kind: 'select-server'; id: string | null }
  | { kind: 'connect'; confirmedRoute?: RemoteRoute }
  | { kind: 'disconnect' }
  | { kind: 'copy-connection' }

export type LocalConnection =
  | { kind: 'disconnected' }
  | { kind: 'connecting' }
  | { kind: 'connected'; scope: 'tab' | 'browser'; tabs: number }
  | { kind: 'reconnecting' }
  | { kind: 'disconnecting' }

export type ActiveConnection =
  | LocalConnection
  | { kind: 'transition'; route: Route; phase: 'connecting' | 'disconnecting' }
  | { kind: 'remote'; route: RemoteRoute; scope: 'tab'; online: boolean }
  | { kind: 'remote'; route: RemoteRoute; scope: 'browser'; online: boolean; tabs: number }

type PendingSelection = { route: Route; tailcatServerId: string | null }

type Preferences = {
  pending: PendingSelection
  servers: { id: string | null; name: string }[]
}

export type ConnectionReply =
  | { kind: 'status'; preferences: Preferences; connection: ActiveConnection; error: string }
  | { kind: 'command'; command: string }
  | { kind: 'descriptor'; descriptor: string }
  | { kind: 'error'; message: string }

export function parseConnectionRequest(value: unknown): ConnectionRequest | undefined {
  if (!value || typeof value !== 'object' || !('kind' in value)) return
  switch (value.kind) {
    case 'status':
    case 'disconnect':
    case 'copy-connection':
      return { kind: value.kind }
    case 'connect':
      return 'confirmedRoute' in value && (value.confirmedRoute === 'hosted' || value.confirmedRoute === 'tailcat')
        ? { kind: 'connect', confirmedRoute: value.confirmedRoute }
        : { kind: 'connect' }
    case 'select':
      if ('route' in value && isRoute(value.route)) return { kind: 'select', route: value.route }
      break
    case 'select-server':
      if ('id' in value && (typeof value.id === 'string' || value.id === null)) {
        return { kind: 'select-server', id: value.id }
      }
  }
}

function parseSelection(value: unknown): PendingSelection | undefined {
  if (!value || typeof value !== 'object' || !('v' in value) || value.v !== 1) return
  if (!('route' in value) || !isRoute(value.route) || !('tailcatServerId' in value)) return
  if (typeof value.tailcatServerId !== 'string' && value.tailcatServerId !== null) return
  return { route: value.route, tailcatServerId: value.tailcatServerId }
}

function readLegacyProfiles(value: unknown): Profiles | undefined {
  if (value === undefined) return
  try {
    return validateProfiles(value)
  } catch {
    // Keep Local usable and leave the saved profiles intact for the legacy manager.
    return undefined
  }
}

async function loadConnectionPreferences(): Promise<{ preferences: Preferences; saved: boolean }> {
  const storage = await chrome.storage.local.get([CONNECTION_SETTINGS_KEY, TAILCAT_PROFILES_KEY])
  const legacy = readLegacyProfiles(storage[TAILCAT_PROFILES_KEY])
  // Keep the existing store authoritative for custom maps while legacy sharing is available.
  // An unmodified Public entry maps to the permanent built-in choice. An edited entry keeps its ID and URL.
  const legacyPublic = legacy?.profiles.find(
    (profile) => profile.name === 'Public' && profile.derpMapURL === PUBLIC_DERP_MAP,
  )
  const servers = [
    { id: null, name: 'Public Tailcat' },
    ...(legacy?.profiles ?? [])
      .filter(({ id }) => id !== legacyPublic?.id)
      .map(({ id, name }) => ({
        id,
        name: name.toLowerCase() === 'public tailcat' ? `${name} (custom)` : name,
      })),
  ]
  const saved = parseSelection(storage[CONNECTION_SETTINGS_KEY])
  const pending: PendingSelection = saved ?? {
    route: legacy?.selectedProfileId ? 'tailcat' : 'local',
    tailcatServerId: legacy?.selectedProfileId ?? null,
  }
  return {
    saved: Boolean(saved),
    preferences: {
      pending: {
        route: pending.route,
        tailcatServerId: servers.some(({ id }) => id === pending.tailcatServerId) ? pending.tailcatServerId : null,
      },
      servers,
    },
  }
}

let preferenceQueue: Promise<unknown> = Promise.resolve()

export function getConnectionPreferences(request: ConnectionRequest): Promise<Preferences> {
  const read = preferenceQueue.then(async () => {
    const { preferences, saved } = await loadConnectionPreferences()
    const { pending, servers } = preferences
    if (request.kind === 'select') {
      pending.route = request.route
    } else if (request.kind === 'select-server') {
      if (!servers.some(({ id }) => id === request.id)) throw new Error('This Tailcat server is unavailable')
      pending.tailcatServerId = request.id
    }
    if (!saved || request.kind === 'select' || request.kind === 'select-server') {
      await chrome.storage.local.set({ [CONNECTION_SETTINGS_KEY]: { v: 1, ...pending } })
    }
    return preferences
  })
  preferenceQueue = read.catch(() => {})
  return read
}
