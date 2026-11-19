import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, win32, posix } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { ProfileStore, ConfigurationError } from './config.js'

export function profileFilePath(
  explicit?: string,
  context = { platform: process.platform as string, env: process.env, home: homedir(), cwd: process.cwd() },
): string {
  const path = context.platform === 'win32' ? win32 : posix
  const configured = explicit ?? context.env.PLAYWRITER_TAILCAT_CONFIG
  if (configured !== undefined) {
    if (!configured) throw new ConfigurationError('CONFIG_INVALID', 'Configuration path is empty')
    return path.resolve(context.cwd, configured)
  }
  const base =
    context.platform === 'win32'
      ? context.env.LOCALAPPDATA || context.home
      : context.env.XDG_CONFIG_HOME && path.isAbsolute(context.env.XDG_CONFIG_HOME)
        ? context.env.XDG_CONFIG_HOME
        : path.join(context.home, '.config')
  return path.join(base, 'playwriter-tailcat', 'profiles.json')
}
async function protectFile(path: string) {
  if (process.platform !== 'win32') return
  const { stdout } = await promisify(execFile)('whoami', [], { windowsHide: true })
  await promisify(execFile)('icacls', [path, '/inheritance:r', '/grant:r', stdout.trim() + ':F'], { windowsHide: true })
}
/** A process lock covers read/seed/CAS/write. Never steal an uncertain lock. */
export async function withProfileFile<T>(path: string, work: (store: ProfileStore) => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const lockPath = path + '.lock'
  let lock: Awaited<ReturnType<typeof open>> | undefined
  const deadline = Date.now() + 5000
  while (!lock) {
    try {
      lock = await open(lockPath, 'wx', 0o600)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new ConfigurationError('CONFIG_WRITE_FAILED', 'Could not lock profile configuration')
      if (Date.now() >= deadline)
        throw new ConfigurationError(
          'CONFIG_BUSY',
          'Profile configuration is locked; close other profile commands before retrying',
        )
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    return await work(
      new ProfileStore({
        read: async () => {
          try {
            const info = await lstat(path)
            if (
              !info.isFile() ||
              info.size > 1024 * 1024 ||
              (process.platform !== 'win32' && (info.uid !== userInfo().uid || (info.mode & 0o077) !== 0))
            )
              throw new Error()
            return JSON.parse(await readFile(path, 'utf8'))
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
            throw new ConfigurationError(
              'CONFIG_INVALID',
              'Saved configuration is invalid or not private; it was not reset',
            )
          }
        },
        write: async (value) => {
          const temp = path + '.' + randomUUID() + '.tmp'
          try {
            const file = await open(temp, 'wx', 0o600)
            try {
              await protectFile(temp)
              await file.writeFile(JSON.stringify(value, null, 2) + '\n')
              await file.sync()
            } finally {
              await file.close()
            }
            await rename(temp, path)
          } finally {
            await unlink(temp).catch(() => {})
          }
        },
      }),
    )
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}
