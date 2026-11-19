import { chromium } from '@xmorse/playwright-core'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect } from 'vitest'
import { startTailcatFixture } from './fixture.js'
import { connectTailcat } from './controller.js'

export const tailcatTestsEnabled = process.env.PLAYWRITER_TAILCAT_TESTS === '1'
export async function setupTailcatTest(options: { extensionDirectory?: string } = {}) {
  const root = resolve('..')
  const nativePath =
    process.env.TAILCAT_NATIVE ||
    join(root, 'tmp/tailcat-assets', process.platform === 'win32' ? 'tailcat.exe' : 'tailcat')
  const profile = await mkdtemp(join(tmpdir(), 'playwriter-derp-lifecycle-'))
  const extensionDirectory = options.extensionDirectory || join(root, 'extension/dist-tailcat')
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
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      ...(process.env.EDGE_PATH ? { executablePath: process.env.EDGE_PATH } : { channel: 'msedge' }),
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        `--disable-extensions-except=${extensionDirectory}`,
        `--load-extension=${extensionDirectory}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    })
  let context = await launch()
  await context.pages()[0].goto(fixture.url)
  let control = await context.newPage()
  const controlURL = 'chrome-extension://pebbngnfojnignonigcnkdilknapkgid/src/tailcat-share.html'
  await control.goto(controlURL)
  const openControl = async () => {
    control = await context.newPage()
    await control.goto(controlURL)
  }
  const restart = async (mode: 'browser' | 'extension' | 'background') => {
    if (mode === 'browser') {
      await context.close()
      context = await launch()
      await context.pages()[0].goto(fixture.url)
    } else if (mode === 'extension') {
      const worker = context
        .serviceWorkers()
        .find((worker) => worker.url().startsWith('chrome-extension://pebbngnfojnignonigcnkdilknapkgid/'))
      if (!worker) throw new Error('Extension service worker unavailable')
      const closed = new Promise<void>((ok) => worker.once('close', () => ok()))
      await worker.evaluate(() => chrome.runtime.reload()).catch(() => {})
      await Promise.race([
        closed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Extension did not reload')), 10_000)),
      ])
      await control.close().catch(() => {})
    } else {
      const cdp = await context.newCDPSession(control)
      const versions = new Map<string, { versionId: string; scriptURL: string; runningStatus: string }>()
      cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updated }) => {
        for (const version of updated) versions.set(version.versionId, version)
      })
      await cdp.send('ServiceWorker.enable')
      await expect
        .poll(
          () =>
            Array.from(versions.values()).find(
              (version) =>
                version.scriptURL.startsWith('chrome-extension://pebbngnfojnignonigcnkdilknapkgid/') &&
                version.runningStatus === 'running',
            ),
          { timeout: 10_000 },
        )
        .toBeTruthy()
      const version = Array.from(versions.values()).find(
        (version) =>
          version.scriptURL.startsWith('chrome-extension://pebbngnfojnignonigcnkdilknapkgid/') &&
          version.runningStatus === 'running',
      )!
      await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId })
      await cdp.detach()
      await control.close()
    }
    control = await context.newPage()
    await control.goto(controlURL)
  }
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
    get context() {
      return context
    },
    get control() {
      return control
    },
    restart,
    openControl,
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
