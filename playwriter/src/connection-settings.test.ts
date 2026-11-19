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
  expect(await serviceWorker.evaluate(() => chrome.runtime.getManifest().permissions?.includes('tabs'))).toBe(false)
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
      args: [
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        '--host-resolver-rules=MAP chromewebstore.google.com ~NOTFOUND',
      ],
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
      const toolbar = manual.locator('[data-playwriter-toolbar="1"]').first()
      await toolbar.waitFor({ state: 'attached' })
      const collapsed = await toolbar.boundingBox()
      if (!collapsed) throw new Error('Local toolbar is missing')
      await manual.mouse.click(collapsed.x + collapsed.width / 2, collapsed.y + collapsed.height / 2)
      await expect.poll(async () => (await toolbar.boundingBox())?.width ?? 0).toBeGreaterThan(collapsed.width)
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

test('Connect Local enrolls existing and future tabs in every regular window', async () => {
  const fixture = await createSimpleServer({
    routes: {
      '/first': '<title>First fixture</title>',
      '/second': '<title>Second fixture</title>',
      '/later': '<title>Later fixture</title>',
    },
  })
  try {
    await withSettings(async ({ browser, serviceWorker, settings, status, connect, cli }) => {
      const first = await browser.newPage()
      await first.goto(new URL('/first', fixture.baseUrl).href)
      const second = browser.waitForEvent('page')
      await serviceWorker.evaluate(async (url) => {
        await chrome.windows.create({ url, type: 'normal' })
      }, new URL('/second', fixture.baseUrl).href)
      await (await second).waitForLoadState()
      await first.bringToFront()

      await connect.click()
      await status.getByText('Connected to Local', { exact: true }).waitFor()
      await status.getByText('2 attached tabs', { exact: true }).waitFor({ timeout: 5000 })
      const created = await cli('session', 'new', '--tab-group', 'lifecycle')
      const session = /Session (\d+) created/.exec(created.stdout)?.[1]
      if (!created.ok || !session) throw new Error('CLI could not start a Local session')
      const titles = async () => {
        const result = await cli(
          '-s',
          session,
          '-e',
          'console.log((await Promise.all(context.pages().map((tab) => tab.title()))).sort().join(", "));',
        )
        expect(result.ok).toBe(true)
        return result.stdout.trim().split(/\r?\n/).at(-1)
      }
      expect(await titles()).toBe('[log] First fixture, Second fixture')

      const later = await browser.newPage()
      await later.goto(new URL('/later', fixture.baseUrl).href)
      await expect.poll(titles, { timeout: 10_000 }).toBe('[log] First fixture, Later fixture, Second fixture')

      await first.close()
      await expect.poll(titles, { timeout: 10_000 }).toBe('[log] Later fixture, Second fixture')
      await (await second).close()
      await later.close()
      await settings.bringToFront()
      await status.getByText('Connected to Local', { exact: true }).waitFor()
      await status.getByText('No eligible tabs', { exact: true }).waitFor({ timeout: 5000 })

      const reopened = await browser.newPage()
      await reopened.goto(new URL('/later', fixture.baseUrl).href)
      await expect.poll(titles, { timeout: 10_000 }).toBe('[log] Later fixture')
    })
  } finally {
    await fixture.close()
  }
}, 120_000)

test('Connect Local follows eligibility without exposing restricted targets or another session’s tabs', async () => {
  const fixture = await createSimpleServer({
    routes: {
      '/shared': '<title>Shared fixture</title>',
      '/owned': '<title>Owned fixture</title><a href="/popup" target="_blank">Open fixture popup</a>',
      '/popup': '<title>Popup fixture</title>',
      '/private': '<title>Private fixture</title>',
    },
  })
  try {
    await withSettings(async ({ browser, serviceWorker, settings, status, connect, cli }) => {
      const shared = await browser.newPage()
      await shared.goto(new URL('/shared', fixture.baseUrl).href)
      const restricted = await browser.newPage()
      await restricted.goto('chrome://settings')
      const untrusted = await browser.newPage()
      await untrusted.goto('data:text/html,<title>Untrusted fixture</title>')
      const storeUrl = 'https://chromewebstore.google.com/'
      await serviceWorker.evaluate(async (url) => {
        await chrome.tabs.create({ url })
      }, storeUrl)
      // The launcher observes that a private fixture really loaded, even when
      // the production extension has no access to the incognito window.
      let sawPrivate = false
      const privateUrl = new URL('/private', fixture.baseUrl).href
      const browserSession = await browser.browser()?.newBrowserCDPSession()
      if (!browserSession) throw new Error('No Chromium browser session for fixture setup')
      browserSession.on('Target.targetInfoChanged', ({ targetInfo }: { targetInfo: { url: string } }) => {
        if (targetInfo.url === privateUrl) sawPrivate = true
      })
      await browserSession.send('Target.setDiscoverTargets', { discover: true })
      await serviceWorker.evaluate(async (url) => {
        await chrome.windows.create({ incognito: true, url })
      }, privateUrl)
      await expect.poll(() => sawPrivate).toBe(true)

      await connect.click()
      await status.getByText('1 attached tab', { exact: true }).waitFor()
      async function session(group: string) {
        const created = await cli('session', 'new', '--tab-group', group)
        const id = /Session (\d+) created/.exec(created.stdout)?.[1]
        if (!created.ok || !id) throw new Error('CLI could not start a Local session')
        return (code: string) => cli('-s', id, '-e', code)
      }
      const observer = await session('observer')
      const owner = await session('owner')
      expect((await observer('state.exposed = []; context.on("page", (tab) => state.exposed.push(tab));')).ok).toBe(
        true,
      )
      const titleList = 'console.log((await Promise.all(context.pages().map((tab) => tab.title()))).sort().join(", "));'
      expect((await observer(titleList)).stdout.trim().endsWith('[log] Shared fixture')).toBe(true)
      const ownedUrl = new URL('/owned', fixture.baseUrl).href
      const opened = await owner(`
        state.owned = await context.newPage();
        await state.owned.goto(${JSON.stringify(ownedUrl)});
        const popup = context.waitForEvent("page");
        await state.owned.getByText("Open fixture popup").click();
        const page = await popup;
        await page.waitForLoadState("domcontentloaded");
        console.log(await page.title());
      `)
      expect(opened.ok, opened.stderr).toBe(true)
      expect(opened.stdout.trim()).toMatch(/\[log\] Popup fixture$/)
      expect(
        (await owner(titleList)).stdout.trim().endsWith('[log] Owned fixture, Popup fixture, Shared fixture'),
      ).toBe(true)
      const observed = await observer('console.log(state.exposed.length); ' + titleList)
      expect(observed.stdout.includes('[log] 0')).toBe(true)
      expect(observed.stdout.trim().endsWith('[log] Shared fixture')).toBe(true)

      const owned = browser.pages().find((page) => page.url() === ownedUrl)
      if (!owned) throw new Error('Owned fixture tab is missing')
      await owned.goto('chrome://settings')
      await expect
        .poll(async () => (await owner(titleList)).stdout.trim().endsWith('[log] Popup fixture, Shared fixture'))
        .toBe(true)
      await owned.goto(ownedUrl)
      await expect
        .poll(async () =>
          (await owner(titleList)).stdout.trim().endsWith('[log] Owned fixture, Popup fixture, Shared fixture'),
        )
        .toBe(true)
      expect((await observer('console.log(state.exposed.length);')).stdout.trim().endsWith('[log] 0')).toBe(true)

      for (const url of ['chrome://settings/', settings.url(), storeUrl, 'data:text/html,untrusted']) {
        const denied = await observer(`await context.pages()[0].goto(${JSON.stringify(url)});`)
        expect(denied.stderr.includes('Playwriter clients cannot open')).toBe(true)
      }
      await shared.goto('chrome://settings')
      await expect
        .poll(async () => (await observer('console.log(context.pages().length);')).stdout.trim().endsWith('[log] 0'))
        .toBe(true)
      await shared.goto(new URL('/shared', fixture.baseUrl).href)
      await expect
        .poll(async () => (await observer(titleList)).stdout.trim().endsWith('[log] Shared fixture'))
        .toBe(true)
      await browserSession.detach()
    })
  } finally {
    await fixture.close()
  }
}, 120_000)

test('Connect Local retries when a temporarily busy debugger becomes available', async () => {
  const fixture = await createSimpleServer({ routes: { '/': '<title>Retry fixture</title>' } })
  try {
    await withSettings(async ({ browser, serviceWorker, status, connect, cli }) => {
      const page = await browser.newPage()
      await page.goto(fixture.baseUrl)
      const tabId = await serviceWorker.evaluate(async (url) => {
        const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)
        if (tab?.id === undefined) throw new Error('Retry fixture tab is missing')
        await chrome.debugger.attach({ tabId: tab.id }, '1.3')
        return tab.id
      }, page.url())
      await connect.click()
      await status.getByText('No eligible tabs', { exact: true }).waitFor()
      // The second attach failed against Chromium's real debugger API. Once
      // released, a later tab navigation is enough to retry enrollment.
      await serviceWorker.evaluate((id) => chrome.debugger.detach({ tabId: id }), tabId)
      await page.reload()
      await status.getByText('1 attached tab', { exact: true }).waitFor()
      const result = await cli('session', 'new', '--tab-group', 'retry')
      const session = /Session (\d+) created/.exec(result.stdout)?.[1]
      if (!result.ok || !session) throw new Error('CLI could not start a Local session')
      const content = await cli('-s', session, '-e', 'console.log(await context.pages()[0].title());')
      expect(content.stdout.trim().endsWith('[log] Retry fixture')).toBe(true)
    })
  } finally {
    await fixture.close()
  }
}, 120_000)

test('Disconnect revokes an in-flight attachment and keeps a separate legacy tab grant', async () => {
  const fixture = await createSimpleServer({
    routes: { '/manual': '<title>Manual fixture</title>', '/late': '<title>Late fixture</title>' },
  })
  try {
    await withSettings(async ({ browser, serviceWorker, status, connect, disconnect, cli }) => {
      const manual = await browser.newPage()
      await manual.goto(new URL('/manual', fixture.baseUrl).href)
      await manual.bringToFront()
      expect(
        await serviceWorker.evaluate(async () => (await globalThis.toggleExtensionForActiveTab()).isConnected),
      ).toBe(true)
      await status.getByText('1 attached tab', { exact: true }).waitFor()
      await connect.click()
      await expect.poll(() => connect.isDisabled()).toBe(true)
      const created = await cli('session', 'new', '--tab-group', 'legacy')
      const session = /Session (\d+) created/.exec(created.stdout)?.[1]
      if (!created.ok || !session) throw new Error('CLI could not start a Local session')

      const gate = await serviceWorker.evaluateHandle(() => {
        const attach = chrome.debugger.attach.bind(chrome.debugger)
        const release = Promise.withResolvers<void>()
        let entered = false
        // Delay Chromium's actual attachment call across settings revocation.
        function delayed(target: chrome.debugger.Debuggee, version: string): Promise<void>
        function delayed(target: chrome.debugger.Debuggee, version: string, callback: () => void): void
        function delayed(target: chrome.debugger.Debuggee, version: string, callback?: () => void) {
          if (callback) return attach(target, version, callback)
          entered = true
          return release.promise.then(() => attach(target, version))
        }
        chrome.debugger.attach = delayed
        return {
          started: () => entered,
          release() {
            chrome.debugger.attach = attach
            release.resolve()
          },
        }
      })
      const late = await browser.newPage()
      try {
        await late.goto(new URL('/late', fixture.baseUrl).href)
        await expect.poll(() => gate.evaluate(({ started }) => started())).toBe(true)
        await disconnect.click()
        await status.getByText('Disconnecting from Local…', { exact: true }).waitFor()
      } finally {
        await gate.evaluate(({ release }) => release())
        await gate.dispose()
      }
      await status.getByText('1 attached tab', { exact: true }).waitFor()
      await status.getByText('Connected to Local (per tab)', { exact: true }).waitFor()
      await expect.poll(() => connect.isEnabled()).toBe(true)
      const result = await cli(
        '-s',
        session,
        '-e',
        'console.log((await Promise.all(context.pages().map((tab) => tab.title()))).join(", "));',
      )
      expect(result.stdout.trim().endsWith('[log] Manual fixture')).toBe(true)
      await manual.locator('[data-playwriter-toolbar="1"]').first().waitFor({ state: 'attached' })
      expect(await late.locator('[data-playwriter-toolbar="1"]').count()).toBe(0)
      await serviceWorker.evaluate(async (url) => {
        const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)
        if (tab?.id === undefined) throw new Error('Late fixture tab is missing')
        await chrome.debugger.attach({ tabId: tab.id }, '1.3')
        await chrome.debugger.detach({ tabId: tab.id })
      }, late.url())
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
