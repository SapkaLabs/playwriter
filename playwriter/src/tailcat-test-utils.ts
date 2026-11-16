import { chromium } from '@xmorse/playwright-core'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect } from 'vitest'
import { startTailcatFixture } from './tailcat-fixture.js'
import { connectTailcat } from './tailcat-controller.js'

export const tailcatTestsEnabled = process.env.PLAYWRITER_TAILCAT_TESTS === '1'
export async function setupTailcatTest() {
  const root = resolve('..')
  const nativePath =
    process.env.TAILCAT_NATIVE ||
    join(root, 'tmp/tailcat-assets', process.platform === 'win32' ? 'tailcat.exe' : 'tailcat')
  const profile = await mkdtemp(join(tmpdir(), 'playwriter-derp-lifecycle-'))
  const fixture = await startTailcatFixture()
  const sentinel = createServer((_request, response) => response.end('healthy sentinel'))
  let rejected = 0
  sentinel.on('upgrade', (_request, socket) => {
    rejected++
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  await new Promise<void>((ok, fail) => {
    sentinel.once('error', fail)
    sentinel.listen(19987, '127.0.0.1', ok)
  })
  const context = await chromium.launchPersistentContext(profile, {
    ...(process.env.EDGE_PATH ? { executablePath: process.env.EDGE_PATH } : { channel: 'msedge' }),
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${join(root, 'extension/dist-tailcat')}`,
      `--load-extension=${join(root, 'extension/dist-tailcat')}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
  await context.pages()[0].goto(fixture.url)
  const control = await context.newPage()
  await control.goto('chrome-extension://pebbngnfojnignonigcnkdilknapkgid/src/tailcat-share.html')
  let sequence = 0
  const connections: Array<Awaited<ReturnType<typeof connectTailcat>>> = []
  const testControl = (command: string, data: Record<string, unknown> = {}) =>
    control.evaluate(({ command, data }) => chrome.runtime.sendMessage({ action: 'tailcatTest', command, ...data }), {
      command,
      data,
    })
  const start = async () => {
    await control.getByRole('button', { name: 'Start sharing', exact: true }).click()
    await expect.poll(() => control.getByRole('status').textContent(), { timeout: 60_000 }).toContain('ready')
    return JSON.parse(await control.getByLabel('Connection information').inputValue())
  }
  const stop = async () => {
    await control.getByRole('button', { name: 'Stop sharing', exact: true }).click()
    await expect.poll(() => control.getByRole('status').textContent()).toContain('stopped')
  }
  const connect = async (descriptor: unknown, extra: Partial<Parameters<typeof connectTailcat>[0]> = {}) => {
    const connection = await connectTailcat({
      descriptor,
      nativePath,
      stateDirectory: join(profile, 'controller-' + ++sequence),
      ...extra,
    })
    connections.push(connection)
    return connection
  }
  const execute = (connection: Awaited<ReturnType<typeof connectTailcat>>, code: string, timeout = 30_000) =>
    promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/cli.ts',
        '--host',
        connection.host,
        '-s',
        connection.sessionId,
        '--timeout',
        String(timeout),
        '-e',
        code,
      ],
      { timeout: timeout + 10_000, maxBuffer: 32 * 1024, env: { ...process.env, PLAYWRITER_TELEMETRY: '0' } },
    )
  return {
    fixture,
    context,
    control,
    nativePath,
    profile,
    connect,
    start,
    stop,
    execute,
    testControl,
    rejected: () => rejected,
    cleanup: async () => {
      for (const connection of connections) await connection.close()
      await context.close()
      await new Promise<void>((ok) => sentinel.close(() => ok()))
      await fixture.close()
      if (!profile.startsWith(join(tmpdir(), 'playwriter-derp-lifecycle-'))) throw Error('Unexpected test profile')
      await rm(profile, { recursive: true, force: true })
    },
  }
}
