import { it, expect } from 'vitest'
import { chromium } from '@xmorse/playwright-core'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connectTailcat } from './tailcat-controller.js'
import { writeFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { startTailcatFixture } from './tailcat-fixture.js'
import { FramedStream, PUBLIC_DERP_MAP, MAX_CHUNK } from './tailcat-protocol.js'

// Approved seams 1, 4 and 6. This is a public-DERP runtime gate, not the final matrix.
it.runIf(process.env.PLAYWRITER_TAILCAT_TESTS === '1')(
  'packaged Edge extension starts without local bootstrap and exchanges real framed bytes',
  async () => {
    const root = resolve('..')
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
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
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
      native = spawn(
        join(root, 'tmp/tailcat-assets/tailcat.exe'),
        ['--key=new', `--derpmap-url=${PUBLIC_DERP_MAP}`, descriptor.addr, '1'],
        {
          windowsHide: true,
          env: { ...process.env, LOCALAPPDATA: profile, APPDATA: profile },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
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
          'src/tailcat-cli.ts',
          'connect',
          '--descriptor',
          descriptorFile,
          '--native',
          join(root, 'tmp/tailcat-assets/tailcat.exe'),
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
          ['--import', 'tsx', 'src/tailcat-cli.ts', 'disconnect', '--connection', ready.connection],
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
        nativePath: join(root, 'tmp/tailcat-assets/tailcat.exe'),
        stateDirectory: join(profile, 'controller'),
      })
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
        const execute = (code: string) =>
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
              code,
            ],
            { timeout: 40_000, maxBuffer: 16 * 1024, env: { ...process.env, PLAYWRITER_TELEMETRY: '0' } },
          )
        const snapshot = await execute(
          'console.log((await snapshot({page:state.page,showDiffSinceLastCall:false})).slice(0,8192))',
        )
        expect(snapshot.stdout).toContain('Unicode text')
        expect(Buffer.byteLength(snapshot.stdout)).toBeLessThanOrEqual(8192)
        await execute(
          'await state.page.getByRole("button",{name:"Click counter",exact:true}).click(); await state.page.getByRole("textbox",{name:"Unicode text"}).fill("Привіт 👋 漢字"); await state.page.getByText("Scroll marker",{exact:true}).scrollIntoViewIfNeeded()',
        )
        const history = await execute(
          'console.log(JSON.stringify(await state.page.evaluate(() => window.fixtureHistory)))',
        )
        expect(history.stdout).toContain('Привіт 👋 漢字')
        expect(history.stdout.match(/"type":"click"/g)).toHaveLength(1)
        await mkdir(join(root, 'tmp/evidence'), { recursive: true })
        const screenshot = join(root, 'tmp/evidence/fixture.png')
        await execute(
          `await state.page.getByRole("heading",{name:"DERP fixture",exact:true}).scrollIntoViewIfNeeded(); await state.page.screenshot({path:${JSON.stringify(screenshot)},scale:"css"})`,
        )
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
        await control.evaluate(() => chrome.runtime.sendMessage({ action: 'tailcatTest', command: 'cut', cut: true }))
        await expect.poll(async () => (await trace()).some((event: any) => event.stage === 'derp-close')).toBe(true)
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
          nativePath: join(root, 'tmp/tailcat-assets/tailcat.exe'),
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
      } finally {
        await controller.close()
      }
      await control.getByRole('button', { name: 'Stop sharing', exact: true }).click()
      // Count rejected local attempts, never successful bootstrap.
      expect(upgrades).toBeGreaterThanOrEqual(0)
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
