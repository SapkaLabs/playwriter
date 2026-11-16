import { it, expect } from 'vitest'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setupTailcatTest, tailcatTestsEnabled } from './tailcat-test-utils.js'

it.runIf(tailcatTestsEnabled && process.env.PLAYWRITER_TAILCAT_DELIVERY === '1')(
  'runs a relocated production developer bundle through public DERP and disconnects it',
  async () => {
    const root = resolve('..'),
      bundle = join(root, 'dist/public-derp')
    const relocated = await mkdtemp(join(tmpdir(), 'playwriter-derp-delivery-'))
    await cp(join(bundle, 'controller'), relocated, { recursive: true })
    const test = await setupTailcatTest({ extensionDirectory: join(bundle, 'extension') })
    let child: ReturnType<typeof spawn> | undefined
    const env = {
      ...process.env,
      PLAYWRITER_TELEMETRY: '0',
      PLAYWRITER_TAILCAT_REGISTRY: join(test.profile, 'registry'),
    }
    try {
      const descriptor = await test.start(),
        descriptorPath = join(test.profile, 'descriptor.json')
      await test.control.getByRole('button', { name: 'Copy connection information' }).click()
      await writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 })
      child = spawn(
        process.execPath,
        [join(relocated, 'tailcat-bin.js'), 'connect', '--descriptor', descriptorPath, '--listen', '127.0.0.1:0'],
        { cwd: relocated, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      let stdout = ''
      const ready = await new Promise<{ host: string; session: string; connection: string; command: string }>(
        (ok, reject) => {
          const timer = setTimeout(() => reject(new Error('Relocated controller never became ready')), 90_000)
          child!.once('error', () => {
            clearTimeout(timer)
            reject(new Error('Relocated controller failed to start'))
          })
          child!.once('exit', () => {
            clearTimeout(timer)
            reject(new Error('Relocated controller exited before readiness'))
          })
          child!.stdout!.on('data', (data) => {
            stdout += String(data)
            if (stdout.length > 32768) {
              clearTimeout(timer)
              reject(new Error('Unexpected controller output'))
              return
            }
            const newline = stdout.indexOf('\n')
            if (newline >= 0) {
              clearTimeout(timer)
              try {
                ok(JSON.parse(stdout.slice(0, newline)))
              } catch {
                reject(new Error('Invalid controller readiness'))
              }
            }
          })
        },
      )
      expect(ready.command).toContain('--timeout 30000')
      const run = promisify(execFile)
      const result = await run(
        process.execPath,
        [
          join(relocated, 'bin.js'),
          '--host',
          ready.host,
          '-s',
          ready.session,
          '--timeout',
          '30000',
          '-e',
          `state.page=context.pages().find(p=>p.url()===${JSON.stringify(test.fixture.url)}); console.log(await state.page.title()); await state.page.getByRole('button',{name:'Click counter',exact:true}).click(); console.log(JSON.stringify(await state.page.evaluate(()=>window.fixtureHistory)))`,
        ],
        { cwd: relocated, env, windowsHide: true, timeout: 40_000, maxBuffer: 8192 },
      )
      expect(result.stdout).toContain('DERP fixture')
      expect(result.stdout.match(/"type":"click"/g)).toHaveLength(1)
      const exited = new Promise<void>((ok) => child!.once('exit', () => ok()))
      await run(process.execPath, [join(relocated, 'tailcat-bin.js'), 'disconnect', '--connection', ready.connection], {
        cwd: relocated,
        env,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 8192,
      })
      await Promise.race([
        exited,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Disconnected supervisor stayed alive')), 5000)),
      ])
      await expect
        .poll(() => test.control.getByRole('button', { name: 'Stop sharing', exact: true }).isEnabled())
        .toBe(true)
      await test.stop()
      expect(await test.control.getByRole('status').textContent()).toBe('stopped')
    } finally {
      child?.kill()
      await test.cleanup()
      if (!relocated.startsWith(join(tmpdir(), 'playwriter-derp-delivery-')))
        throw new Error('Unexpected delivery directory')
      await rm(relocated, { recursive: true, force: true })
    }
  },
  150_000,
)
