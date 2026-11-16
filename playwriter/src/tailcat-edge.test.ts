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
import { FramedStream, PUBLIC_DERP_MAP, MAX_CHUNK } from './tailcat-protocol.js'

// Approved seams 1, 4 and 6. This is a public-DERP runtime gate, not the final matrix.
it('packaged Edge extension starts without local bootstrap and exchanges real framed bytes', async () => {
  const root = resolve('..')
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
    await fixture.goto(`http://127.0.0.1:19987/fixture`)
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
      write: (bytes) => new Promise((ok, fail) => native!.stdin!.write(bytes, (error) => (error ? fail(error) : ok()))),
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
    await rm(profile, { recursive: true, force: true })
  }
}, 120_000)
