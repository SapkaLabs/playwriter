// Disposable Edge UI/evidence harness. Never drives measured browser operations through its setup pipe.
import { chromium } from '../playwright/packages/playwright-core/index.mjs'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startTailcatFixture } from '../playwriter/src/tailcat-tunnel/fixture.js'

const root = resolve('.')
const run = resolve('tmp/ui-acceptance')
await mkdir(run, { recursive: true, mode: 0o700 })
const profile = await mkdtemp(join(tmpdir(), 'playwriter-derp-ui-'))
const fixture = await startTailcatFixture()
let rejectedUpgrades = 0
const sentinel = createServer((_request, response) => response.end('healthy discovery sentinel'))
sentinel.on('upgrade', (_request, socket) => {
  rejectedUpgrades++
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
})
await new Promise<void>((ok, fail) => {
  sentinel.once('error', fail)
  sentinel.listen(19987, '127.0.0.1', ok)
})
const extension = process.env.PLAYWRITER_UI_EXTENSION || join(root, 'extension/dist-tailcat')
const context = await chromium.launchPersistentContext(profile, {
  ...(process.env.EDGE_PATH ? { executablePath: process.env.EDGE_PATH } : { channel: 'msedge' }),
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
})
const fixturePage = context.pages()[0]
await fixturePage.goto(fixture.url)
const control = await context.newPage()
await control.goto('chrome-extension://pebbngnfojnignonigcnkdilknapkgid/src/tailcat-share.html')
await writeFile(
  join(run, 'harness.json'),
  JSON.stringify(
    {
      profile,
      fixture: fixture.url,
      nonce: fixture.nonce,
      browser: context.browser()?.version(),
      startedAt: new Date().toISOString(),
      pid: process.pid,
    },
    null,
    2,
  ),
)
// File commands only observe private state or operate dedicated test faults;
// Start/Copy/Stop are always clicked using browser/computer tools in the UI run.
const commands = createServer(async (request, response) => {
  if (request.headers.origin || request.headers.host !== '127.0.0.1:19986' || request.method !== 'POST') {
    response.writeHead(403).end()
    return
  }
  try {
    if (request.url === '/descriptor') {
      await writeFile(join(run, 'descriptor.json'), await control.getByLabel('Connection information').inputValue(), {
        mode: 0o600,
      })
      response.end('private descriptor saved')
    } else if (request.url === '/observe') {
      const trace = await control.evaluate(() =>
        chrome.runtime.sendMessage({ action: 'tailcatTest', command: 'trace' }),
      )
      await writeFile(
        join(run, 'trace.json'),
        JSON.stringify({ trace, rejectedUpgrades, requests: fixture.requests, at: new Date().toISOString() }, null, 2),
      )
      response.end((await control.getByRole('status').textContent()) || '')
    } else if (
      /^\/barrier\/(arm|release|status)\/(startup-before-listen|startup-after-descriptor|dispatch)$/.test(
        request.url || '',
      )
    ) {
      const [, , operation, name] = request.url!.split('/')
      const command = operation === 'arm' ? 'barrierArm' : operation === 'release' ? 'barrierRelease' : 'barrierStatus'
      const result = await control.evaluate(
        ({ command, name }) =>
          chrome.runtime.sendMessage({
            action: 'tailcatTest',
            command,
            name,
            method: name === 'dispatch' ? 'Runtime.evaluate' : undefined,
          }),
        { command, name },
      )
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify(result))
    } else if (request.url === '/fixture-close') {
      await fixturePage.close()
      response.end('owned fixture tab closed')
    } else if (request.url === '/cut' || request.url === '/restore' || request.url === '/dispose') {
      const command = request.url === '/dispose' ? 'dispose' : 'cut'
      await control.evaluate(
        ({ command, cut }) => chrome.runtime.sendMessage({ action: 'tailcatTest', command, cut }),
        { command, cut: request.url === '/cut' },
      )
      response.end('test fault applied')
    } else if (request.url === '/shutdown') {
      response.end('closing owned harness')
      void close()
    } else response.writeHead(404).end()
  } catch {
    response.writeHead(500).end('Harness command failed')
  }
})
await new Promise<void>((ok, fail) => {
  commands.once('error', fail)
  commands.listen(19986, '127.0.0.1', ok)
})
console.log('Disposable Edge UI harness ready; owned control endpoint 19986 (no browser Start/Stop helpers).')
async function close() {
  await context.close()
  sentinel.close()
  commands.close()
  await fixture.close()
  // The resolved profile is exactly the mkdtemp-owned test directory.
  if (!profile.startsWith(join(tmpdir(), 'playwriter-derp-ui-'))) throw new Error('Unexpected owned profile path')
  await rm(profile, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGINT', () => {
  void close()
})
process.on('SIGTERM', () => {
  void close()
})
