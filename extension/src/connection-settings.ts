import {
  ConfigurationError,
  ProfileStore,
  validateProfiles,
  type Profiles,
  type ServerProfile,
} from 'playwriter/src/tailcat-tunnel/config'
import { PUBLIC_DERP_MAP } from 'playwriter/src/tailcat-tunnel/protocol'

export const CONNECTION_SETTINGS_PAGE = 'src/connection-settings.html'
export const MANAGE_SERVERS_PAGE = 'src/manage-servers.html'
const CONNECTION_SETTINGS_KEY = 'playwriterConnectionSettings'
const TAILCAT_PROFILES_KEY = 'tailcatProfiles'

export type Route = 'local' | 'hosted' | 'tailcat'
export type RemoteRoute = Exclude<Route, 'local'>

export function isRoute(route: unknown): route is Route {
  return route === 'local' || route === 'hosted' || route === 'tailcat'
}

type CustomServerReference = Readonly<{ kind: 'custom'; id: ServerProfile['id']; revision: number }>
export type ServerReference = Readonly<{ kind: 'public' }> | CustomServerReference
export type ServerChoice = ServerReference & Readonly<{ name: string }>
export type ServerSnapshot = ServerChoice & Readonly<{ derpMapURL: string }>
export const PUBLIC_TAILCAT = {
  kind: 'public',
  name: 'Public Tailcat',
  derpMapURL: PUBLIC_DERP_MAP,
} satisfies ServerSnapshot

export type ConnectionTarget = { route: 'local' } | { route: 'hosted' } | { route: 'tailcat'; server: ServerReference }

export function sameServer(left: ServerReference, right: ServerReference): boolean {
  return left.kind === 'public'
    ? right.kind === 'public'
    : right.kind === 'custom' && left.id === right.id && left.revision === right.revision
}

export function serverChoice(server: ServerSnapshot): ServerChoice {
  return server.kind === 'public'
    ? { kind: 'public', name: server.name }
    : { kind: 'custom', id: server.id, revision: server.revision, name: server.name }
}

export function serverName(server: ServerChoice): string {
  return server.kind === 'custom' && server.name.toLowerCase() === PUBLIC_TAILCAT.name.toLowerCase()
    ? server.name + ' (custom)'
    : server.name
}

export function routeName(route: Route, server?: ServerChoice): string {
  if (route === 'tailcat') return server ? serverName(server) : 'Tailcat'
  return route === 'hosted' ? 'playwriter.dev' : 'Local'
}

export type ConnectionRequest =
  | { kind: 'status' }
  | { kind: 'select'; route: Route }
  | { kind: 'select-server'; id: string | null }
  | { kind: 'connect'; target: ConnectionTarget }
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
  | { kind: 'transition'; name: string; phase: 'connecting' | 'disconnecting' }
  | { kind: 'remote'; route: RemoteRoute; scope: 'tab'; online: boolean }
  | { kind: 'remote'; route: 'hosted'; scope: 'browser'; online: boolean; tabs: number }
  | { kind: 'remote'; route: 'tailcat'; scope: 'browser'; online: boolean; tabs: number; server: ServerChoice }

type PendingSelection = { route: Route; tailcatServerId: string | null }
type StoredPreferences =
  | ({ v: 1 } & PendingSelection)
  | ({ v: 2; legacyPublic: CustomServerReference | null } & PendingSelection)

type Preferences = {
  pending: PendingSelection
  servers: ServerChoice[]
}

export type ConnectionReply =
  | { kind: 'status'; preferences: Preferences; connection: ActiveConnection; error: string }
  | { kind: 'command'; command: string }
  | { kind: 'descriptor'; descriptor: string }
  | { kind: 'error'; message: string }

export type ServerDirectory = { revision: number; custom: ServerProfile[] }
export type ServerRequest =
  | { kind: 'list' }
  | { kind: 'add'; expectedRevision: number; name: string; derpMapURL: string }
  | { kind: 'edit'; expectedRevision: number; server: CustomServerReference; name: string; derpMapURL: string }
  | { kind: 'remove'; expectedRevision: number; server: CustomServerReference }
  | { kind: 'validate'; server: CustomServerReference }

export type ServerReply =
  | { kind: 'directory'; directory: ServerDirectory }
  | { kind: 'validated'; regions: number }
  | { kind: 'error'; message: string }

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{16,64}$/.test(value)
}

function parseCustomServer(value: unknown): CustomServerReference | undefined {
  if (
    value &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind === 'custom' &&
    'id' in value &&
    isProfileId(value.id) &&
    'revision' in value &&
    isRevision(value.revision)
  ) {
    return { kind: 'custom', id: value.id, revision: value.revision }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseServerChoice(value: unknown): ServerChoice | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return
  if (value.kind === 'public') return { kind: 'public', name: value.name }
  const reference = parseCustomServer(value)
  if (reference) return { ...reference, name: value.name }
}

function parseActiveConnection(value: unknown): ActiveConnection | undefined {
  if (!isRecord(value)) return
  const { kind, scope, tabs, route, online, phase, name } = value
  switch (kind) {
    case 'disconnected':
    case 'connecting':
    case 'reconnecting':
    case 'disconnecting':
      return { kind }
    case 'connected':
      if ((scope === 'tab' || scope === 'browser') && isRevision(tabs)) return { kind, scope, tabs }
      return
    case 'transition':
      if ((phase === 'connecting' || phase === 'disconnecting') && typeof name === 'string') {
        return { kind, name, phase }
      }
      return
    case 'remote':
      if (typeof online !== 'boolean' || (route !== 'hosted' && route !== 'tailcat')) return
      if (scope === 'tab') return { kind, route, scope, online }
      if (scope !== 'browser' || !isRevision(tabs)) return
      if (route === 'hosted') return { kind, route, scope, online, tabs }
      const server = parseServerChoice(value.server)
      if (server) return { kind, route, scope, online, tabs, server }
  }
}

export function parseConnectionStatusReply(value: unknown): Extract<ConnectionReply, { kind: 'status' | 'error' }> {
  if (isRecord(value)) {
    if (value.kind === 'error' && typeof value.message === 'string') {
      return { kind: 'error', message: value.message }
    }
    if (value.kind === 'status' && typeof value.error === 'string' && isRecord(value.preferences)) {
      const { pending, servers } = value.preferences
      const connection = parseActiveConnection(value.connection)
      if (connection && isRecord(pending) && Array.isArray(servers) && isRoute(pending.route)) {
        const { route, tailcatServerId } = pending
        const choices = servers.map(parseServerChoice)
        if (
          (tailcatServerId === null || isProfileId(tailcatServerId)) &&
          choices.every((choice) => choice !== undefined)
        ) {
          return {
            kind: 'status',
            preferences: { pending: { route, tailcatServerId }, servers: choices },
            connection,
            error: value.error,
          }
        }
      }
    }
  }
  throw new Error('Invalid connection status')
}

export function parseConnectionCopyReply(value: unknown): Extract<ConnectionReply, { kind: 'command' | 'descriptor' }> {
  if (isRecord(value)) {
    if (value.kind === 'command' && typeof value.command === 'string')
      return { kind: 'command', command: value.command }
    if (value.kind === 'descriptor' && typeof value.descriptor === 'string') {
      return { kind: 'descriptor', descriptor: value.descriptor }
    }
  }
  throw new Error('Connection information unavailable')
}

export function parseServerReply(value: unknown, request: ServerRequest['kind']): ServerReply {
  if (isRecord(value)) {
    if (value.kind === 'error' && typeof value.message === 'string') return { kind: 'error', message: value.message }
    if (request === 'validate' && value.kind === 'validated' && isRevision(value.regions)) {
      return { kind: 'validated', regions: value.regions }
    }
    if (request !== 'validate' && value.kind === 'directory' && isRecord(value.directory)) {
      const { revision, profiles: custom } = validateProfiles({
        v: 1,
        revision: value.directory.revision,
        profiles: value.directory.custom,
        selectedProfileId: null,
      })
      return { kind: 'directory', directory: { revision, custom } }
    }
  }
  throw new Error('Invalid saved server settings')
}

function parseTarget(value: unknown): ConnectionTarget | undefined {
  if (!value || typeof value !== 'object' || !('route' in value)) return
  if (value.route === 'local' || value.route === 'hosted') return { route: value.route }
  if (value.route !== 'tailcat' || !('server' in value)) return
  const server = value.server
  if (server && typeof server === 'object' && 'kind' in server && server.kind === 'public') {
    return { route: 'tailcat', server: { kind: 'public' } }
  }
  const custom = parseCustomServer(server)
  if (custom) return { route: 'tailcat', server: custom }
}

export function parseConnectionRequest(value: unknown): ConnectionRequest | undefined {
  if (!value || typeof value !== 'object' || !('kind' in value)) return
  switch (value.kind) {
    case 'status':
    case 'disconnect':
    case 'copy-connection':
      return { kind: value.kind }
    case 'connect': {
      const target = 'target' in value && parseTarget(value.target)
      if (target) return { kind: 'connect', target }
      break
    }
    case 'select':
      if ('route' in value && isRoute(value.route)) return { kind: 'select', route: value.route }
      break
    case 'select-server':
      if ('id' in value && (isProfileId(value.id) || value.id === null)) {
        return { kind: 'select-server', id: value.id }
      }
  }
}

export function parseServerRequest(value: unknown): ServerRequest | undefined {
  if (!value || typeof value !== 'object' || !('kind' in value)) return
  if (value.kind === 'list') return { kind: 'list' }
  const server = 'server' in value && parseCustomServer(value.server)
  if (value.kind === 'validate') return server ? { kind: 'validate', server } : undefined
  if (!('expectedRevision' in value) || !isRevision(value.expectedRevision)) return
  const { expectedRevision } = value
  if (value.kind === 'remove') return server ? { kind: 'remove', expectedRevision, server } : undefined
  if (
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !('derpMapURL' in value) ||
    typeof value.derpMapURL !== 'string'
  )
    return
  const { name, derpMapURL } = value
  if (value.kind === 'add') return { kind: 'add', expectedRevision, name, derpMapURL }
  if (value.kind === 'edit' && server) return { kind: 'edit', expectedRevision, server, name, derpMapURL }
}

function parseSelection(value: unknown): StoredPreferences | undefined {
  if (!value || typeof value !== 'object' || !('v' in value)) return
  if (!('route' in value) || !isRoute(value.route) || !('tailcatServerId' in value)) return
  if (value.tailcatServerId !== null && !isProfileId(value.tailcatServerId)) return
  const { route, tailcatServerId } = value
  if (value.v === 1) return { v: 1, route, tailcatServerId }
  if (value.v !== 2 || !('legacyPublic' in value)) return
  const legacyPublic = value.legacyPublic === null ? null : parseCustomServer(value.legacyPublic)
  if (legacyPublic !== undefined) return { v: 2, route, tailcatServerId, legacyPublic }
}

export const tailcatProfiles = new ProfileStore({
  read: async () => (await chrome.storage.local.get(TAILCAT_PROFILES_KEY))[TAILCAT_PROFILES_KEY],
  write: async (value) => {
    await chrome.storage.local.set({ [TAILCAT_PROFILES_KEY]: value })
  },
})

type ProfileState = { kind: 'available'; profiles: Profiles } | { kind: 'unavailable'; error: unknown }

function customReference(profile: ServerProfile): CustomServerReference {
  return { kind: 'custom', id: profile.id, revision: profile.revision }
}

function customServers(profiles: Profiles, legacyPublic: CustomServerReference | null | undefined): ServerProfile[] {
  // Leave the legacy store intact. Only its stock Public entry at migration
  // represents the built-in choice; later edits and additions are custom.
  return profiles.profiles.filter((profile) => !legacyPublic || !sameServer(customReference(profile), legacyPublic))
}

async function loadPreferences() {
  const storage = await chrome.storage.local.get([CONNECTION_SETTINGS_KEY, TAILCAT_PROFILES_KEY])
  const saved = parseSelection(storage[CONNECTION_SETTINGS_KEY])
  const previousProfiles: unknown = storage[TAILCAT_PROFILES_KEY]
  let profileState: ProfileState
  try {
    const profiles = previousProfiles === undefined ? await tailcatProfiles.read() : validateProfiles(previousProfiles)
    profileState = { kind: 'available', profiles }
  } catch (error) {
    // Local is available even if the legacy data cannot be read. Preserve a
    // saved custom choice so damaged data cannot route its Connect to Public.
    profileState = { kind: 'unavailable', error }
  }
  const profiles = profileState.kind === 'available' ? profileState.profiles : undefined
  const legacySelection = previousProfiles === undefined ? null : (profiles?.selectedProfileId ?? null)
  const stockPublic =
    saved?.v === 2
      ? undefined
      : profiles?.profiles.find((profile) => profile.name === 'Public' && profile.derpMapURL === PUBLIC_DERP_MAP)
  const legacyPublic =
    saved?.v === 2 ? saved.legacyPublic : stockPublic ? customReference(stockPublic) : profiles ? null : undefined
  const pending: PendingSelection = saved
    ? { route: saved.route, tailcatServerId: saved.tailcatServerId }
    : { route: legacySelection ? 'tailcat' : 'local', tailcatServerId: legacySelection }
  const custom = profiles ? customServers(profiles, legacyPublic) : []
  if (profiles && !custom.some(({ id }) => id === pending.tailcatServerId)) pending.tailcatServerId = null
  return { pending, profileState, legacyPublic, custom, saved }
}

let preferenceQueue: Promise<unknown> = Promise.resolve()

function serialPreferences<T>(work: () => Promise<T>): Promise<T> {
  const result = preferenceQueue.then(work)
  preferenceQueue = result.catch(() => {})
  return result
}

async function saveSelection({ pending, legacyPublic, saved }: Awaited<ReturnType<typeof loadPreferences>>) {
  const value: StoredPreferences =
    legacyPublic === undefined ? { v: 1, ...pending } : { v: 2, ...pending, legacyPublic }
  if (saved?.v !== value.v || saved.route !== pending.route || saved.tailcatServerId !== pending.tailcatServerId) {
    await chrome.storage.local.set({ [CONNECTION_SETTINGS_KEY]: value })
  }
}

export function getConnectionPreferences(request: ConnectionRequest) {
  return serialPreferences(async () => {
    const state = await loadPreferences()
    const { pending, custom } = state
    const servers: ServerSnapshot[] = [
      PUBLIC_TAILCAT,
      ...custom.map((profile) => ({ ...profile, ...customReference(profile) })),
    ]
    if (request.kind === 'select') {
      pending.route = request.route
    } else if (request.kind === 'select-server') {
      if (request.id !== null && !custom.some(({ id }) => id === request.id)) {
        throw new ConfigurationError(
          'PROFILE_NOT_FOUND',
          'This server is unavailable. Choose another server or open Manage Servers.',
        )
      }
      pending.tailcatServerId = request.id
    }
    await saveSelection(state)
    const selected = servers.find((server) =>
      server.kind === 'public' ? pending.tailcatServerId === null : server.id === pending.tailcatServerId,
    )
    return { preferences: { pending, servers: servers.map(serverChoice) }, selected }
  })
}

export function manageServer(request: ServerRequest): Promise<ServerDirectory | ServerProfile> {
  return serialPreferences(async () => {
    const state = await loadPreferences()
    const { profileState, legacyPublic, custom } = state
    if (profileState.kind === 'unavailable') throw profileState.error
    await saveSelection(state)
    if (request.kind === 'list') return { revision: profileState.profiles.revision, custom }

    if ('server' in request) {
      const profile = custom.find((profile) => sameServer(customReference(profile), request.server))
      if (!profile) {
        throw new ConfigurationError('CONFIG_CONFLICT', 'This server changed. Reopen its settings and try again.')
      }
      if (request.kind === 'validate') return profile
    }
    const updated = await tailcatProfiles.update({
      ...request,
      action: request.kind,
      id: 'server' in request ? request.server.id : undefined,
    })
    return { revision: updated.revision, custom: customServers(updated, legacyPublic) }
  })
}
