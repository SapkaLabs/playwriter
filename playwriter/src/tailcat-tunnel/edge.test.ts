import { it, expect } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { execFile, execFileSync } from 'node:child_process'
import { WebSocket } from 'ws'
import { promisify } from 'node:util'
import { connectTailcat } from './controller.js'
import { writeFile, readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { startTailcatFixture } from './fixture.js'
import { FramedStream, PUBLIC_DERP_MAP, MAX_CHUNK } from './protocol.js'

// Approved seams 1, 4 and 6. This is a public-DERP runtime gate, not the final matrix.
it.runIf(process.env.PLAYWRITER_TAILCAT_TESTS === '1')(
  'packaged Edge extension starts without local bootstrap and exchanges real framed bytes',
  async () => {
    const root = resolve('..')
    const nativePath =
      process.env.TAILCAT_NATIVE ||
      join(root, 'tmp/tailcat-assets', process.platform === 'win32' ? 'tailcat.exe' : 'tailcat')
    const fixtureServer = await startTailcatFixture()
    const profile = await mkdtemp(join(tmpdir(), 'playwriter-derp-edge-'))
    const sentinel = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end('<title>DERP fixture</title><p>fixture</p>')
    })
    let upgrades = 0
    sentinel.on('upgrade', (_req, socket) => {
      upgrades++
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    })
    await new Promise<void>((ok) => sentinel.listen(19987, '127.0.0.1', ok))
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
    let native: ReturnType<typeof spawn> | undefined
    const deniedUpgrade = (url: string) =>
      new Promise<number>((ok, reject) => {
        const socket = new WebSocket(url)
        const timer = setTimeout(() => {
          socket.terminate()
          reject(new Error('Upgrade probe timed out'))
        }, 5000)
        socket.once('unexpected-response', (_request, response) => {
          clearTimeout(timer)
          response.resume()
          ok(response.statusCode || 0)
        })
        socket.once('open', () => {
          clearTimeout(timer)
          socket.close()
          reject(new Error('Ordinary local upgrade unexpectedly accepted'))
        })
        socket.once('error', () => {
          clearTimeout(timer)
          reject(new Error('Upgrade probe failed before rejection status'))
        })
      })
    try {
      const fixture = context.pages()[0]
      await fixture.goto(fixtureServer.url)
      const control = await context.newPage()
      await control.goto('chrome-extension://pebbngnfojnignonigcnkdilknapkgid/src/tailcat-share.html')
      await control.getByRole('button', { name: 'Start sharing', exact: true }).click()
      await expect.poll(() => control.getByRole('status').textContent(), { timeout: 60_000 }).toContain('ready')
      await control.getByRole('button', { name: 'Copy connection information' }).click()
      // Clipboard is kept private inside this disposable profile; never print the descriptor.
      const descriptor = JSON.parse(await control.getByLabel('Connection information').inputValue())
      expect(descriptor).toMatchObject({
        v: 1,
        transport: 'playwriter-tailcat',
        port: 1,
        relayMode: 'public',
        derpMapURL: PUBLIC_DERP_MAP,
      })
      native = spawn(nativePath, ['--key=new', `--derpmap-url=${PUBLIC_DERP_MAP}`, descriptor.addr, '1'], {
        windowsHide: true,
        env: { ...process.env, LOCALAPPDATA: profile, APPDATA: profile },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const messages: any[] = []
      const errors: Error[] = []
      const framed = new FramedStream({
        write: (bytes) =>
          new Promise((ok, fail) => native!.stdin!.write(bytes, (error) => (error ? fail(error) : ok()))),
        onMessage: async (json) => {
          messages.push(JSON.parse(json))
        },
        onError: (error) => {
          errors.push(error)
        },
      })
      native.stdout!.on('data', (bytes: Buffer) => {
        native!.stdout!.pause()
        void (async () => {
          for (let i = 0; i < bytes.length; i += MAX_CHUNK) await framed.receive(bytes.subarray(i, i + MAX_CHUNK))
          native!.stdout!.resume()
        })()
      })
      await framed.start()
      await framed.ready
      await framed.send('{"method":"ping"}')
      await expect.poll(() => messages.some((m) => m.method === 'pong'), { timeout: 30_000 }).toBe(true)
      expect(messages.some((m) => m.method === 'hello')).toBe(true)
      expect(messages.some((m) => m.params?.method === 'Target.attachedToTarget')).toBe(true)
      expect(errors).toEqual([])
      await control.getByRole('button', { name: 'Stop sharing', exact: true }).click()
      await expect.poll(() => control.getByRole('status').textContent()).toContain('stopped')
      await control.getByRole('button', { name: 'Start sharing', exact: true }).click()
      await expect.poll(() => control.getByRole('status').textContent(), { timeout: 60_000 }).toContain('ready')
      const descriptorFile = join(profile, 'descriptor.json')
      await writeFile(descriptorFile, await control.getByLabel('Connection information').inputValue(), { mode: 0o600 })
      const publicSupervisor = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'src/tailcat-tunnel/cli.ts',
          'connect',
          '--descriptor',
          descriptorFile,
          '--native',
          nativePath,
          '--listen',
          '127.0.0.1:0',
        ],
        {
          env: { ...process.env, PLAYWRITER_TELEMETRY: '0', PLAYWRITER_TAILCAT_REGISTRY: join(profile, 'connections') },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      try {
        let output = ''
        publicSupervisor.stdout!.on('data', (chunk) => {
          output += chunk
        })
        await expect.poll(() => output.includes('\n'), { timeout: 60_000 }).toBe(true)
        const ready = JSON.parse(output.trim())
        const read = await promisify(execFile)(
          process.execPath,
          [
            '--import',
            'tsx',
            'src/cli.ts',
            '--host',
            ready.host,
            '-s',
            ready.session,
            '-e',
            'console.log(await context.pages()[0].title())',
          ],
          { timeout: 30_000, env: { ...process.env, PLAYWRITER_TELEMETRY: '0' } },
        )
        expect(read.stdout).toContain('DERP fixture')
        const disconnected = await promisify(execFile)(
          process.execPath,
          ['--import', 'tsx', 'src/tailcat-tunnel/cli.ts', 'disconnect', '--connection', ready.connection],
          { timeout: 10_000, env: { ...process.env, PLAYWRITER_TAILCAT_REGISTRY: join(profile, 'connections') } },
        )
        expect(disconnected.stdout).toContain('browser sharing remains active')
        await expect.poll(() => publicSupervisor.exitCode, { timeout: 5000 }).toBe(0)
        expect(await control.getByRole('status').textContent()).not.toContain('stopped')
      } finally {
        publicSupervisor.kill()
      }
      await control.getByRole('button', { name: 'Stop sharing', exact: true }).click()
      await expect.poll(() => control.getByRole('status').textContent()).toContain('stopped')
      framed.close()
      await control.getByRole('button', { name: 'Start sharing', exact: true }).click()
      await expect.poll(() => control.getByRole('status').textContent(), { timeout: 60_000 }).toContain('ready')
      const secondDescriptor = JSON.parse(await control.getByLabel('Connection information').inputValue())
      const controller = await connectTailcat({
        descriptor: secondDescriptor,
        nativePath,
        stateDirectory: join(profile, 'controller'),
      })
      const operationTimings: Array<{ operation: number; ms: number; completed: boolean }> = []
      try {
        const command = await promisify(execFile)(
          process.execPath,
          [
            '--import',
            'tsx',
            'src/cli.ts',
            '--host',
            controller.host,
            '-s',
            controller.sessionId,
            '-e',
            'state.page = context.pages().find(p => p.url().endsWith("/fixture")); console.log(await state.page.title())',
          ],
          { timeout: 30_000, env: { ...process.env, PLAYWRITER_TELEMETRY: '0' } },
        )
        expect(command.stdout).toContain('DERP fixture')
        expect(controller.extensionId).toMatch(/^remote:/)
        expect(new Set([19987, controller.relayPort, controller.adapterPort, fixtureServer.port]).size).toBe(4)
        expect(await deniedUpgrade('ws://127.0.0.1:19987/extension')).toBe(403)
        expect(await deniedUpgrade(controller.host.replace('http:', 'ws:') + '/extension')).toBe(403)
        const registrations = (await (await fetch(controller.host + '/extensions/status')).json()) as {
          extensions: Array<{ extensionId: string; stableKey: string }>
        }
        expect(registrations.extensions.map((entry) => entry.stableKey)).toEqual([controller.extensionId])
        expect(registrations.extensions.every((entry) => entry.extensionId.startsWith('remote_'))).toBe(true)
        const localStatus = (await (await fetch(controller.host + '/extension/status')).json()) as {
          connected: boolean
        }
        expect(localStatus.connected).toBe(false)
        let nativeSockets: unknown[] = []
        if (process.platform === 'win32') {
          if (!Number.isSafeInteger(controller.nativePid) || controller.nativePid <= 0)
            throw new Error('Invalid native process identity')
          const observed = await promisify(execFile)(
            'powershell.exe',
            [
              '-NoProfile',
              '-Command',
              `Get-NetTCPConnection -OwningProcess ${controller.nativePid} -State Established -ErrorAction SilentlyContinue | Select-Object RemoteAddress,RemotePort | ConvertTo-Json -Compress`,
            ],
            { windowsHide: true, timeout: 10_000 },
          )
          const sockets = JSON.parse(observed.stdout)
          nativeSockets = Array.isArray(sockets) ? sockets : [sockets]
          expect(
            nativeSockets.some(
              (socket: any) => socket.RemotePort === 443 && !['127.0.0.1', '::1'].includes(socket.RemoteAddress),
            ),
          ).toBe(true)
        }
        const execute = async (code: string) => {
          const started = performance.now()
          let completed = false
          try {
            const result = await promisify(execFile)(
              process.execPath,
              [
                '--import',
                'tsx',
                'src/cli.ts',
                '--host',
                controller.host,
                '-s',
                controller.sessionId,
                '--timeout',
                '30000',
                '-e',
                code,
              ],
              { timeout: 40_000, maxBuffer: 16 * 1024, env: { ...process.env, PLAYWRITER_TELEMETRY: '0' } },
            )
            completed = true
            return result
          } finally {
            operationTimings.push({
              operation: operationTimings.length + 1,
              ms: performance.now() - started,
              completed,
            })
          }
        }
        const snapshot = await execute(
          'console.log((await snapshot({page:state.page,showDiffSinceLastCall:false})).slice(0,8192))',
        )
        expect(snapshot.stdout).toContain('Unicode text')
        expect(Buffer.byteLength(snapshot.stdout)).toBeLessThanOrEqual(8192)
        await execute('await state.page.getByRole("button",{name:"Click counter",exact:true}).click()')
        await execute('await state.page.getByRole("textbox",{name:"Unicode text"}).fill("Привіт 👋 漢字")')
        await execute('await state.page.getByText("Scroll marker",{exact:true}).scrollIntoViewIfNeeded()')
        const history = await execute(
          'console.log(JSON.stringify(await state.page.evaluate(() => window.fixtureHistory)))',
        )
        expect(history.stdout).toContain('Привіт 👋 漢字')
        expect(history.stdout.match(/"type":"click"/g)).toHaveLength(1)
        await mkdir(join(root, 'tmp/evidence'), { recursive: true })
        const screenshot = join(root, 'tmp/evidence/fixture.png')
        await execute('await state.page.getByRole("heading",{name:"DERP fixture",exact:true}).scrollIntoViewIfNeeded()')
        await execute(`await state.page.screenshot({path:${JSON.stringify(screenshot)},scale:"css"})`)
        const consoleOutput = await execute(
          'console.log(JSON.stringify((await getLatestLogs({page:state.page,count:20}))).slice(0,4096))',
        )
        expect(Buffer.byteLength(consoleOutput.stdout)).toBeLessThanOrEqual(4096)
        const selectedJSON = await execute(
          'state.response = state.page.waitForResponse(r => new URL(r.url()).pathname === "/json"); await state.page.getByRole("button",{name:"Load JSON",exact:true}).click(); state.response = await state.response; const body = await state.response.body(); if(body.length>65536) throw Error("Selected JSON body exceeds 64 KiB"); console.log(body.toString().slice(0,8192))',
        )
        expect(selectedJSON.stdout).toContain(fixtureServer.nonce)
        expect(fixtureServer.requests['/json']).toBe(1)
        const oversized = await execute(
          'state.large = state.page.waitForResponse(r => new URL(r.url()).pathname === "/oversized"); await state.page.getByRole("button",{name:"Load oversized JSON",exact:true}).click(); const body=await (await state.large).body(); console.log(body.length>65536?"Selected JSON body exceeds 64 KiB":"unexpected small body")',
        )
        expect(oversized.stdout).toContain('exceeds 64 KiB')
        expect(fixtureServer.requests['/oversized']).toBe(1)
        const unavailable = await execute(
          'state.cdp=await getCDPSession({page:state.page}); await state.cdp.send("Network.enable",{maxTotalBufferSize:64,maxResourceBufferSize:32}); state.evictedId=null; state.cdp.on("Network.responseReceived",e=>{if(new URL(e.response.url).pathname==="/evicted") state.evictedId=e.requestId}); state.evictedDone=new Promise(ok=>state.cdp.on("Network.loadingFinished",e=>{if(e.requestId===state.evictedId) ok()})); await state.page.getByRole("button",{name:"Load evicted JSON",exact:true}).click(); await state.evictedDone; try {await state.cdp.send("Network.getResponseBody",{requestId:state.evictedId}); console.log("unexpected available body")} catch(error){console.log("Selected body unavailable: "+error.message.slice(0,200))}',
        )
        expect(unavailable.stdout).toContain('Selected body unavailable:')
        expect(fixtureServer.requests['/evicted']).toBe(1)
        await execute(
          'await state.page.getByRole("link",{name:"Navigate fixture"}).click(); console.log(await state.page.title())',
        )
        const retained = await execute(
          'console.log(JSON.stringify(await state.page.evaluate(() => window.fixtureHistory)))',
        )
        expect(retained.stdout).toContain('Привіт 👋 漢字')
        const trace = () =>
          control.evaluate(() => chrome.runtime.sendMessage({ action: 'tailcatTest', command: 'trace' }))
        await expect.poll(async () => (await trace()).some((event: any) => event.stage === 'derp-open')).toBe(true)
        const cut = await control.evaluate(() =>
          chrome.runtime.sendMessage({ action: 'tailcatTest', command: 'cut', cut: true }),
        )
        expect(cut.trackedIds.length).toBeGreaterThan(0)
        await expect
          .poll(async () => {
            const events = await trace()
            return cut.trackedIds.every((id: number) =>
              events.some((event: any) => event.stage === 'derp-close' && event.socketId === id),
            )
          })
          .toBe(true)
        await expect
          .poll(async () => (await trace()).some((event: any) => event.stage === 'derp-denied'), { timeout: 15_000 })
          .toBe(true)
        expect((await fetch('http://127.0.0.1:19987/fixture')).ok).toBe(true)
        expect((await fetch(controller.host + '/version')).ok).toBe(true)
        expect((await fetch(fixtureServer.url)).ok).toBe(true)
        await expect(
          promisify(execFile)(
            process.execPath,
            [
              '--import',
              'tsx',
              'src/cli.ts',
              '--host',
              controller.host,
              '-s',
              controller.sessionId,
              '--timeout',
              '30000',
              '-e',
              'console.log(await state.page.title())',
            ],
            { timeout: 40_000, env: { ...process.env, PLAYWRITER_TELEMETRY: '0' } },
          ),
        ).rejects.toThrow()
        await expect.poll(() => controller.isTerminal(), { timeout: 5000 }).toBe(true)
        await control.evaluate(() => chrome.runtime.sendMessage({ action: 'tailcatTest', command: 'dispose' }))
        await control.evaluate(() => chrome.runtime.sendMessage({ action: 'tailcatTest', command: 'cut', cut: false }))
        const recovered = await connectTailcat({
          descriptor: secondDescriptor,
          nativePath,
          stateDirectory: join(profile, 'recovered'),
        })
        try {
          const read = await promisify(execFile)(
            process.execPath,
            [
              '--import',
              'tsx',
              'src/cli.ts',
              '--host',
              recovered.host,
              '-s',
              recovered.sessionId,
              '-e',
              'console.log((await context.pages()[0].title()))',
            ],
            { timeout: 30_000, env: { ...process.env, PLAYWRITER_TELEMETRY: '0' } },
          )
          expect(read.stdout).toContain('DERP fixture')
        } finally {
          await recovered.close()
        }
        const browserTrace = await trace()
        const correlated = controller.trace.filter(
          (frame) =>
            frame.direction === 'write' &&
            frame.id !== undefined &&
            browserTrace.some(
              (event: any) =>
                event.stage === 'browser-frame' &&
                event.direction === 'read' &&
                event.id === frame.id &&
                event.bytes === frame.bytes,
            ),
        )
        expect(correlated.length).toBeGreaterThan(0)
        await mkdir(join(root, 'tmp/evidence'), { recursive: true })
        await writeFile(
          join(root, 'tmp/evidence/edge-acceptance.json'),
          JSON.stringify(
            {
              at: new Date().toISOString(),
              sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
              browser: context.browser()!.version(),
              extensionVersion: JSON.parse(await readFile(join(root, 'extension/dist-tailcat/manifest.json'), 'utf8'))
                .version,
              endpoints: { B: 19987, R: controller.relayPort, A: controller.adapterPort, F: fixtureServer.port },
              connection: controller.connectionId,
              session: controller.sessionId,
              extensionId: controller.extensionId,
              processIds: { native: controller.nativePid, relay: controller.relayPid, adapter: controller.adapterPid },
              operationTimings,
              nativeSockets,
              ordinaryUpgradeProbes: 'B=403,R=403',
              allEstablishedSocketsClosed: cut.trackedIds,
              correlatedCommandFrames: correlated.length,
              controllerTrace: controller.trace,
              browserTrace,
              requests: fixtureServer.requests,
              result: 'passed',
            },
            null,
            2,
          ) + '\n',
        )
      } catch (error) {
        const failures = controller.failures.map((reason) =>
          /^(Native|Fixture|Owned|Relay|Truncated|Pending|Invalid|Protocol|Connection|Preface)/.test(reason)
            ? reason
            : 'Transport failure',
        )
        const browserTrace = await control
          .evaluate(() => chrome.runtime.sendMessage({ action: 'tailcatTest', command: 'trace' }))
          .catch(() => [])
        await mkdir(join(root, 'tmp/evidence'), { recursive: true })
        await writeFile(
          join(root, 'tmp/evidence/edge-failure.json'),
          JSON.stringify(
            {
              at: new Date().toISOString(),
              result: 'failed',
              terminal: controller.isTerminal(),
              failures,
              operationTimings,
              controllerTrace: controller.trace,
              browserTrace,
            },
            null,
            2,
          ) + '\n',
        )
        throw error
      } finally {
        await controller.close()
      }
      await control.getByRole('button', { name: 'Stop sharing', exact: true }).click()
      // Count rejected local attempts, never successful bootstrap.
      expect(upgrades).toBeGreaterThan(0)
    } finally {
      native?.kill()
      await context.close()
      await new Promise<void>((ok) => sentinel.close(() => ok()))
      await fixtureServer.close()
      await rm(profile, { recursive: true, force: true })
    }
  },
  300_000,
)
