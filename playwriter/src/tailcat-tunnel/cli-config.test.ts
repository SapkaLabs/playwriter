import { it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('runs CLI profile CRUD and rejects conflicting assertions before invoking a native executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'derp-cli-config-'))
  const config = join(directory, 'profiles.json')
  const run = (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'src/tailcat-tunnel/cli.ts', ...args, '--config', config],
      {
        windowsHide: true,
        timeout: 15_000,
        env: { ...process.env, PLAYWRITER_TAILCAT_CONFIG: join(directory, 'wrong.json') },
      },
    )
  try {
    const initial = JSON.parse((await run('profile', 'list')).stdout)
    const added = JSON.parse((await run('profile', 'add', 'Lab', '--derp-map-url', 'https://map.example/map')).stdout)
    const id = added.profiles.find((p: any) => p.name === 'Lab').id
    const edited = JSON.parse((await run('profile', 'edit', id, '--name', 'Office')).stdout)
    expect(edited.profiles.find((p: any) => p.name === 'Office').id).toBe(id)
    expect(JSON.parse((await run('profile', 'select', id)).stdout).selectedProfileId).toBe(id)
    const descriptor = join(directory, 'descriptor.json')
    await writeFile(
      descriptor,
      JSON.stringify({
        v: 2,
        transport: 'playwriter-tailcat',
        addr: 'tc' + 'a'.repeat(20),
        port: 1,
        shareId: '1'.repeat(32),
        derpMapURL: 'https://another.example/map',
        derpMapSha256: '2'.repeat(64),
        regionId: 900,
      }),
      { mode: 0o600 },
    )
    // Invalid native path proves these cases terminate before address-parser spawn.
    for (const assertion of [
      ['--profile', 'Office'],
      ['--derp-map-url', 'https://map.example/map'],
      ['--profile', 'Office', '--derp-map-url', 'https://map.example/map'],
    ]) {
      await expect(
        run('connect', '--descriptor', descriptor, '--native', join(directory, 'does-not-exist'), ...assertion),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('SERVER_MISMATCH') })
    }
    await expect(
      run('connect', '--descriptor', descriptor, '--native', join(directory, 'does-not-exist')),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('Tailcat native runtime is missing') })
    expect(JSON.parse((await run('profile', 'remove', id)).stdout).selectedProfileId).toBeNull()
    await run('profile', 'remove', initial.profiles[0].id)
    expect(JSON.parse((await run('profile', 'list')).stdout).profiles).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
