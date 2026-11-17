import { it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withProfileFile, profileFilePath } from './profile-file.js'

it('atomically persists CLI profiles and rejects a competing stale update', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'derp-profiles-'))
  const path = join(dir, 'profiles.json')
  try {
    const initial = await withProfileFile(path, (store) => store.read())
    const changed = await withProfileFile(path, (store) =>
      store.update({
        action: 'add',
        name: 'Lab',
        derpMapURL: 'https://map.example/map',
        expectedRevision: initial.revision,
      }),
    )
    await expect(
      withProfileFile(path, (store) =>
        store.update({ action: 'select', id: null, expectedRevision: initial.revision }),
      ),
    ).rejects.toThrow('CONFIG_CONFLICT')
    expect((await withProfileFile(path, (store) => store.read())).profiles).toEqual(changed.profiles)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('explicit configuration path wins over environment and platform defaults', () => {
  expect(profileFilePath('chosen.json')).toBe(join(process.cwd(), 'chosen.json'))
})

it.each(['linux', 'darwin'])('uses absolute XDG paths and portable precedence on %s', (platform) => {
  const context = {
    platform,
    env: { XDG_CONFIG_HOME: '/config', PLAYWRITER_TAILCAT_CONFIG: 'env.json' },
    home: '/users/test',
    cwd: '/work',
  }
  expect(profileFilePath('chosen.json', context)).toBe('/work/chosen.json')
  expect(profileFilePath(undefined, context)).toBe('/work/env.json')
  expect(profileFilePath(undefined, { ...context, env: { XDG_CONFIG_HOME: '/config' } })).toBe(
    '/config/playwriter-tailcat/profiles.json',
  )
  expect(profileFilePath(undefined, { ...context, env: { XDG_CONFIG_HOME: 'relative' } })).toBe(
    '/users/test/.config/playwriter-tailcat/profiles.json',
  )
})
it('uses Windows local application data without mixing XDG or POSIX paths', () => {
  const context = {
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', XDG_CONFIG_HOME: '/wrong' },
    home: 'C:\\Users\\test',
    cwd: 'D:\\work',
  }
  expect(profileFilePath(undefined, context)).toBe('C:\\Users\\test\\AppData\\Local\\playwriter-tailcat\\profiles.json')
  expect(profileFilePath('profiles.json', context)).toBe('D:\\work\\profiles.json')
})
