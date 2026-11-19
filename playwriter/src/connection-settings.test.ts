import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium, type BrowserContext } from '@xmorse/playwright-core'
import { expect, test } from 'vitest'
import { WebSocketServer } from 'ws'
import { startPlayWriterCDPRelayServer } from './cdp-relay.js'
import { createCdpLogger } from './cdp-log.js'
import { createFileLogger } from './create-logger.js'
import { createSimpleServer } from './test-utils.js'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const extensionDir = join(root, 'extension')
const extensionRequire = createRequire(join(extensionDir, 'package.json'))

async function runCli(relayPort: number, directory: string, args: string[]) {
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--import', 'tsx', 'playwriter/src/cli.ts', ...args], {
      cwd: root,
      timeout: 25_000,
      windowsHide: true,
      env: {
        ...process.env,
        PLAYWRITER_HOST: `http://127.0.0.1:${relayPort}`,
        PLAYWRITER_PORT: String(relayPort),
        PLAYWRITER_TOKEN: '',
        PLAYWRITER_STATE_DIRECTORY: directory,
      },
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
      return { ok: false, stdout: String(error.stdout), stderr: String(error.stderr) }
    }
    throw error
  }
}

async function getServiceWorker(browser: BrowserContext) {
  const [worker] = browser.serviceWorkers()
  return worker ?? (await browser.waitForEvent('serviceworker'))
}

async function openSettings(browser: BrowserContext) {
  const serviceWorker = await getServiceWorker(browser)
  const settingsPath = await serviceWorker.evaluate(() => chrome.runtime.getManifest().options_page)
  if (!settingsPath) throw new Error('The extension did not register Connection settings')
  const settings = await browser.newPage()
  try {
    await settings.goto(new URL(settingsPath, serviceWorker.url()).href)
  } catch {
    throw new Error('Could not open Connection settings')
  }
  const status = settings.getByRole('region', { name: 'Current connection' })
  const connect = settings.getByRole('button', { name: 'Connect', exact: true })
  const disconnect = settings.getByRole('button', { name: 'Disconnect', exact: true })
  const route = (name: string) => settings.getByRole('radio', { name, exact: true })
  return { browser, serviceWorker, settings, status, connect, disconnect, route }
}

function reserveRelayPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close((error) => {
        if (error || !address || typeof address === 'string') reject(error ?? new Error('No relay port available'))
        else resolve(address.port)
      })
    })
  })
}

async function withSettings(
  run: (
    context: Awaited<ReturnType<typeof openSettings>> & {
      restart: () => ReturnType<typeof openSettings>
      cli: (...args: string[]) => ReturnType<typeof runCli>
      startRelay: () => Promise<void>
    },
  ) => Promise<void>,
  {
    relayRunning = true,
    initializeProfile,
  }: {
    relayRunning?: boolean
    initializeProfile?: (worker: Awaited<ReturnType<typeof getServiceWorker>>) => Promise<void>
  } = {},
) {
  const relayPort = await reserveRelayPort()
  const directory = await mkdtemp(join(tmpdir(), 'pw-connection-settings-'))
  const dist = join(directory, 'extension')
  const logger = createFileLogger({ logFilePath: join(directory, 'relay.log') })
  const cdpLogger = createCdpLogger({ logFilePath: join(directory, 'cdp.jsonl') })
  let relay: Awaited<ReturnType<typeof startPlayWriterCDPRelayServer>> | undefined
  let browser: BrowserContext | undefined
  const startRelay = async () => {
    relay = await startPlayWriterCDPRelayServer({ port: relayPort, stateDirectory: directory, logger, cdpLogger })
  }
  const launch = async () => {
    browser = await chromium.launchPersistentContext(join(directory, 'profile'), {
      executablePath: process.env.PLAYWRITER_TEST_BROWSER,
      channel: 'chromium',
      headless: !process.env.HEADFUL,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    })
    return browser
  }
  const restart = async () => {
    await browser?.close()
    return openSettings(await launch())
  }
  try {
    const vite = extensionRequire.resolve('vite/package.json').replace(/package\.json$/, 'bin/vite.js')
    await exec(process.execPath, [vite, 'build', '--config', 'vite.config.mts'], {
      cwd: extensionDir,
      windowsHide: true,
      env: {
        ...process.env,
        TESTING: '',
        // Keep the recognized dev ID with the production permission set.
        PRODUCTION: '',
        PLAYWRITER_AUTO_CONNECT_LOCAL: '',
        PLAYWRITER_PORT: String(relayPort),
        PLAYWRITER_EXTENSION_DIST: dist,
        PLAYWRITER_OPEN_WELCOME_PAGE: '0',
      },
    })
    if (relayRunning) await startRelay()
    const initial = await launch()
    if (initializeProfile) await initializeProfile(await getServiceWorker(initial))
    await run({
      ...(await openSettings(initial)),
      restart,
      startRelay,
      cli: (...args) => runCli(relayPort, directory, args),
    })
  } finally {
    await browser?.close()
    relay?.close()
    await Promise.all([logger.flush(), cdpLogger.flush()])
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
  }
}

test('Local settings grant and revoke actual CLI access', async () => {
  const fixture = await createSimpleServer({ routes: { '/': '<title>Local fixture</title><h1>Ready</h1>' } })
  const fixtureUrl = new URL('/', fixture.baseUrl).href
  try {
    await withSettings(async ({ browser, serviceWorker, settings, status, route, connect, disconnect, cli }) => {
      await status.getByText('Disconnected', { exact: true }).waitFor()
      expect(await route('Local').isChecked()).toBe(true)
      expect((await cli('session', 'new')).ok).toBe(false)

      await connect.click()
      await status.getByText('Connected to Local', { exact: true }).waitFor()
      await status.getByText('No eligible tabs', { exact: true }).waitFor()
      const created = await cli('session', 'new', '--tab-group', 'fixture')
      const session = /Session (\d+) created/.exec(created.stdout)?.[1]
      if (!created.ok || !session) throw new Error('CLI could not start a Local session')
      const runFixture = () =>
        cli(
          '-s',
          session,
          '-e',
          `state.page ??= await context.newPage();
        await state.page.goto(${JSON.stringify(fixtureUrl)});
        console.log(await state.page.title());`,
        )
      expect((await runFixture()).stdout).toContain('Local fixture')
      const restricted = await cli('-s', session, '-e', `await state.page.goto(${JSON.stringify(settings.url())});`)
      expect(restricted.stderr.includes('Playwriter clients cannot open extension pages.')).toBe(true)

      await route('Tailcat').check()
      await status.getByText('Connected to Local', { exact: true }).waitFor()
      await settings.getByText('The selected route is unavailable in Connection settings.').waitFor()
      expect(await connect.isDisabled()).toBe(true)
      expect((await runFixture()).stdout).toContain('Local fixture')

      const other = await cli('session', 'new', '--tab-group', 'observer')
      const otherSession = /Session (\d+) created/.exec(other.stdout)?.[1]
      if (!other.ok || !otherSession) throw new Error('CLI could not start another Local session')
      const observer = await cli(
        '-s',
        otherSession,
        '-e',
        `console.log(context.pages().some((tab) =>
        tab.url() === ${JSON.stringify(fixtureUrl)}));`,
      )
      expect(observer.stdout.trim().endsWith('[log] false')).toBe(true)

      await disconnect.click()
      await status.getByText('Disconnected', { exact: true }).waitFor()
      const revoked = await runFixture()
      expect(revoked.stdout).not.toContain('Local fixture')
      expect(revoked.stderr).toMatch(/connect|closed/i)
      expect((await cli('session', 'new')).ok).toBe(false)

      const manual = await browser.newPage()
      await manual.goto(fixtureUrl)
      await manual.bringToFront()
      const attached = await serviceWorker.evaluate(async () => globalThis.toggleExtensionForActiveTab())
      expect(attached.isConnected).toBe(true)
      const shared = await cli('session', 'new', '--tab-group', 'manual')
      const sharedSession = /Session (\d+) created/.exec(shared.stdout)?.[1]
      if (!shared.ok || !sharedSession) throw new Error('CLI could not start a per-tab session')
      const perTab = await cli(
        '-s',
        sharedSession,
        '-e',
        `console.log(await context.pages().find((tab) =>
        tab.url() === ${JSON.stringify(fixtureUrl)})?.title());`,
      )
      expect(perTab.stdout).toContain('Local fixture')
    })
  } finally {
    await fixture.close()
  }
}, 120_000)

test('selecting Local preserves an existing share until Connect replaces it', async () => {
  const fixture = await createSimpleServer({ routes: { '/': '<title>Share fixture</title>' } })
  const edge = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  try {
    await once(edge, 'listening')
    const address = edge.address()
    if (!address || typeof address === 'string') throw new Error('No hosted tunnel fixture port')
    const endpoint = `ws://127.0.0.1:${address.port}`
    await withSettings(async ({ browser, serviceWorker, settings, status, route, connect, cli }) => {
      const shared = await browser.newPage()
      await shared.goto(fixture.baseUrl)
      await shared.bringToFront()
      const shareClosed = new Promise<void>((resolve) => {
        edge.once('connection', (socket) => {
          socket.once('close', () => resolve())
          socket.send(JSON.stringify({ type: 'upstream_accepted' }))
        })
      })
      await serviceWorker.evaluate(async (endpoint) => {
        const BrowserWebSocket = WebSocket
        // Keep the existing share's WebSocket protocol on loopback for the fixture.
        globalThis.WebSocket = class extends BrowserWebSocket {
          constructor(...[url, protocols]: ConstructorParameters<typeof BrowserWebSocket>) {
            super(new URL(url).protocol === 'wss:' ? endpoint : url, protocols)
          }
        }
        await globalThis.startRemoteControlForActiveTab()
      }, endpoint)
      await settings.bringToFront()
      await status.getByText('Connected to playwriter.dev', { exact: true }).waitFor()
      await route('Tailcat').check()
      await route('Local').check()
      await settings.getByText('Connect replaces the current connection.').waitFor()
      expect(edge.clients.size).toBe(1)
      await connect.click()
      await shareClosed
      await status.getByText('Connected to Local', { exact: true }).waitFor()
      expect((await cli('session', 'new', '--tab-group', 'fixture')).ok).toBe(true)
    })
  } finally {
    for (const socket of edge.clients) socket.terminate()
    await Promise.all([fixture.close(), new Promise<void>((resolve) => edge.close(() => resolve()))])
  }
}, 120_000)

test('a failed Local Connect stays disconnected when the relay starts until the user retries', async () => {
  await withSettings(
    async ({ settings, status, route, connect, cli, startRelay }) => {
      await status.getByText('Disconnected', { exact: true }).waitFor()
      await connect.click()
      await status.getByText('Connecting to Local…', { exact: true }).waitFor()
      await settings.getByText('Could not reach the local relay.', { exact: false }).waitFor()
      await status.getByText('Disconnected', { exact: true }).waitFor()
      expect(await route('Local').isChecked()).toBe(true)
      await startRelay()
      expect((await cli('session', 'new')).ok).toBe(false)
      await connect.click()
      await status.getByText('Connected to Local', { exact: true }).waitFor()
      expect((await cli('session', 'new')).ok).toBe(true)
    },
    { relayRunning: false },
  )
}, 120_000)

test.each([
  { scenario: 'customized Public selection', selectLegacy: true },
  { scenario: 'no saved selection', selectLegacy: false },
])(
  'legacy migration preserves custom servers with $scenario',
  async ({ selectLegacy }) => {
    await withSettings(
      async ({ settings, status, route, connect, restart }) => {
        await status.getByText('Disconnected', { exact: true }).waitFor()
        expect(await route(selectLegacy ? 'Tailcat' : 'Local').isChecked()).toBe(true)
        if (!selectLegacy) await route('Tailcat').check()
        const pendingServer = selectLegacy ? 'Public' : 'Public Tailcat'
        const servers = settings.getByRole('combobox', { name: 'Tailcat server' })
        expect(await servers.locator('option').allTextContents()).toEqual(['Public Tailcat', 'Public'])
        expect(await servers.locator('option:checked').textContent()).toBe(pendingServer)
        expect(await connect.isDisabled()).toBe(true)
        await route('playwriter.dev').check()
        await expect.poll(() => route('playwriter.dev').isEnabled()).toBe(true)

        const reopened = await restart()
        await reopened.status.getByText('Disconnected', { exact: true }).waitFor()
        expect(await reopened.route('playwriter.dev').isChecked()).toBe(true)
        await reopened.route('Tailcat').check()
        expect(
          await reopened.settings
            .getByRole('combobox', { name: 'Tailcat server' })
            .locator('option:checked')
            .textContent(),
        ).toBe(pendingServer)
      },
      {
        // Seed the previous release's persisted data before the first settings read.
        initializeProfile: (worker) =>
          worker.evaluate(async (selected) => {
            const id = 'a4a46cac-2fce-4e63-835c-fa791810ac88'
            await chrome.storage.local.set({
              tailcatProfiles: {
                v: 1,
                revision: 1,
                selectedProfileId: selected ? id : null,
                profiles: [{ id, name: 'Public', derpMapURL: 'https://fixture.invalid/map.json', revision: 1 }],
              },
            })
          }, selectLegacy),
      },
    )
  },
  120_000,
)
