/** Shared browser/CLI configuration. Stores contain no connection capabilities. */
import { PUBLIC_DERP_MAP } from './protocol.js'

export class ConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}
export function configurationError(error: unknown): string {
  return error instanceof ConfigurationError ? error.message : 'CONFIG_INVALID: Configuration operation failed'
}
export function mapURL(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !/^https:\/\//i.test(value) ||
    /[\\\s\u0000-\u001f\u007f]/u.test(value) ||
    /%(?![0-9a-f]{2})/i.test(value)
  )
    throw new ConfigurationError('MAP_URL_INVALID', 'Supply an absolute HTTPS DERP-map URL, not a relay hostname')
  try {
    const url = new URL(value)
    if (
      !url.hostname ||
      url.port === '0' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value.includes('?') ||
      value.includes('#')
    )
      throw new Error()
    return url.href
  } catch {
    throw new ConfigurationError(
      'MAP_URL_INVALID',
      'Supply an absolute HTTPS DERP-map URL without credentials, query or fragment',
    )
  }
}
function profileName(value: unknown): string {
  if (typeof value !== 'string') throw new ConfigurationError('CONFIG_INVALID', 'A profile name is required')
  const name = value.trim().normalize('NFC')
  if (!name || Array.from(name).length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(name))
    throw new ConfigurationError('CONFIG_INVALID', 'Profile names must contain 1–64 characters without controls')
  return name
}
export type ServerProfile = { id: string; name: string; derpMapURL: string; revision: number }
export type Profiles = { v: 1; revision: number; selectedProfileId: string | null; profiles: ServerProfile[] }
export type ProfileMutation = {
  action: 'add' | 'edit' | 'remove' | 'select'
  expectedRevision: number
  id?: string | null
  name?: string
  derpMapURL?: string
}
export function validateProfiles(value: unknown): Profiles {
  const data = value as Profiles
  const validRevision = (n: number) => Number.isSafeInteger(n) && n >= 0
  if (
    !data ||
    data.v !== 1 ||
    !validRevision(data.revision) ||
    !Array.isArray(data.profiles) ||
    data.profiles.length > 256
  )
    throw new ConfigurationError('CONFIG_INVALID', 'Saved profile configuration is invalid; it was not reset')
  const ids = new Set<string>(),
    names = new Set<string>()
  for (const p of data.profiles) {
    if (
      !p ||
      typeof p.id !== 'string' ||
      !/^[a-f0-9-]{16,64}$/.test(p.id) ||
      ids.has(p.id) ||
      !validRevision(p.revision) ||
      p.name !== profileName(p.name) ||
      p.derpMapURL !== mapURL(p.derpMapURL) ||
      names.has(p.name.toLowerCase())
    )
      throw new ConfigurationError('CONFIG_INVALID', 'Saved profile configuration is invalid; it was not reset')
    ids.add(p.id)
    names.add(p.name.toLowerCase())
  }
  if (data.selectedProfileId !== null && !ids.has(data.selectedProfileId))
    throw new ConfigurationError('CONFIG_INVALID', 'Selected profile does not exist')
  return structuredClone(data)
}
export function findProfile(data: Profiles, reference?: string | null): ServerProfile {
  // IDs are authoritative. An editable name that happens to equal another
  // profile's ID must never redirect selection to a different server.
  const p =
    data.profiles.find((p) => p.id === (reference ?? data.selectedProfileId)) ??
    (reference
      ? data.profiles.find((p) => p.name.toLowerCase() === reference.normalize('NFC').toLowerCase())
      : undefined)
  if (!p)
    throw new ConfigurationError(reference ? 'PROFILE_NOT_FOUND' : 'PROFILE_REQUIRED', 'Select or add a server profile')
  return p
}
export class ProfileStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private storage: { read(): Promise<unknown>; write(value: Profiles): Promise<void> }) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work)
    this.queue = result.catch(() => {})
    return result
  }
  private async load(): Promise<Profiles> {
    const value = await this.storage.read()
    if (value !== undefined) return validateProfiles(value)
    const id = crypto.randomUUID()
    const data: Profiles = {
      v: 1,
      revision: 0,
      selectedProfileId: id,
      profiles: [{ id, name: 'Public', derpMapURL: PUBLIC_DERP_MAP, revision: 0 }],
    }
    await this.save(data)
    return data
  }
  private async save(data: Profiles): Promise<void> {
    try {
      await this.storage.write(validateProfiles(data))
    } catch (e) {
      if (e instanceof ConfigurationError) throw e
      throw new ConfigurationError('CONFIG_WRITE_FAILED', 'Could not save profiles; previous settings retained')
    }
  }
  read(): Promise<Profiles> {
    return this.serial(() => this.load())
  }
  update(change: ProfileMutation): Promise<Profiles> {
    return this.serial(async () => {
      const data = await this.load()
      if (change.expectedRevision !== data.revision)
        throw new ConfigurationError('CONFIG_CONFLICT', 'Profiles changed; reload before saving')
      if (change.action === 'add') {
        data.profiles.push({
          id: crypto.randomUUID(),
          name: profileName(change.name),
          derpMapURL: mapURL(change.derpMapURL),
          revision: 0,
        })
      } else if (change.action === 'select') {
        data.selectedProfileId = change.id === null ? null : findProfile(data, change.id).id
      } else if (change.action === 'edit' || change.action === 'remove') {
        const p = findProfile(data, change.id)
        if (change.action === 'remove') {
          data.profiles = data.profiles.filter((other) => other.id !== p.id)
          if (data.selectedProfileId === p.id) data.selectedProfileId = null
        } else {
          if (change.name !== undefined) p.name = profileName(change.name)
          if (change.derpMapURL !== undefined) p.derpMapURL = mapURL(change.derpMapURL)
          p.revision++
        }
      } else throw new ConfigurationError('CONFIG_INVALID', 'Unknown profile action')
      data.revision++
      await this.save(data)
      return structuredClone(data)
    })
  }
}
