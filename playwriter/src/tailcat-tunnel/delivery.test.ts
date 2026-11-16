import { it, expect } from 'vitest'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setupTailcatTest, tailcatTestsEnabled } from './test-utils.js'

it.runIf(tailcatTestsEnabled && process.env.PLAYWRITER_TAILCAT_DELIVERY === '1')(
  'runs a relocated production developer bundle through public DERP and disconnects it',
  async () => {
    const root = resolve('..'),
      bundle = join(root, 'dist/public-derp')
    const relocated = await mkdtemp(join(tmpdir(), 'playwriter-derp-delivery-'))
    await cp(join(bundle, 'controller'), relocated, { recursive: true })
    const test = await setupTailcatTest({ extensionDirectory: join(bundle, 'extension') })
    let child: ReturnType<typeof spawn> | undefined
    let controllerStderr = ''
    const operationTimings: Array<{ operation: number; ms: number; completed: boolean }> = []
    const report = async (result: 'passed' | 'failed') => {
      const fixture = test.context.pages().find((page) => page.url().startsWith(new URL(test.fixture.url).origin + '/'))
      const observedFixture = await fixture
        ?.evaluate(() => ({
          scrollY: window.scrollY,
          history: (window as any).fixtureHistory?.slice(-20),
        }))
        .catch(() => undefined)
      await mkdir(join(root, 'tmp/evidence'), { recursive: true })
      await writeFile(
        join(root, 'tmp/evidence/delivery-operations.json'),
        JSON.stringify(
          {
            result,
            at: new Date().toISOString(),
            artifactSource: JSON.parse(await readFile(join(bundle, 'delivery.json'), 'utf8')).sourceCommit,
            operationTimings,
            // Keep only bounded, generic controller stages, never command bodies.
            controllerFailures: controllerStderr
              .split(/\r?\n/)
              .filter((line) =>
                /^(Native|Fixture|Owned|Relay|Truncated|Pending|Invalid|Protocol|Connection|Preface|Controller|Tailcat)[\w ():;,.!?/-]{0,500}$/.test(
                  line,
                ),
              ),
            observedFixture,
            observationPath: 'owned setup pipe, diagnostics only; not operation-route evidence',
          },
          null,
          2,
        ) + '\n',
      )
    }
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
      child.stderr!.on('data', (data: Buffer) => {
        controllerStderr = (controllerStderr + data.toString()).slice(-8192)
      })
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
      const execute = async (code: string) => {
        const started = performance.now()
        let completed = false
        try {
          const result = await run(
            process.execPath,
            [join(relocated, 'bin.js'), '--host', ready.host, '-s', ready.session, '--timeout', '30000', '-e', code],
            { cwd: relocated, env, windowsHide: true, timeout: 40_000, maxBuffer: 8192 },
          )
          completed = true
          return result
        } finally {
          operationTimings.push({ operation: operationTimings.length + 1, ms: performance.now() - started, completed })
        }
      }
      const initial = await execute(
        `state.page=context.pages().find(p=>p.url()===${JSON.stringify(test.fixture.url)}); console.log(await state.page.title())`,
      )
      expect(initial.stdout).toContain('DERP fixture')
      await execute('await state.page.getByRole("button",{name:"Click counter",exact:true}).click()')
      await execute('await state.page.getByRole("textbox",{name:"Unicode text"}).fill("Привіт 👋 漢字")')
      const result = await execute('console.log(JSON.stringify(await state.page.evaluate(()=>window.fixtureHistory)))')
      expect(result.stdout.match(/"type":"click"/g)).toHaveLength(1)
      expect(result.stdout).toContain('Привіт 👋 漢字')
      const snapshot = await execute(
        'console.log((await snapshot({page:state.page,showDiffSinceLastCall:false})).slice(0,8192))',
      )
      expect(snapshot.stdout).toContain('Unicode text')
      expect(Buffer.byteLength(snapshot.stdout)).toBeLessThanOrEqual(8192)
      await mkdir(join(root, 'tmp/evidence'), { recursive: true })
      const screenshot = join(root, 'tmp/evidence/delivery-viewport.png')
      await execute(
        `state.imageBytes=(await state.page.screenshot({path:${JSON.stringify(screenshot)},scale:'css'})).length; if(state.imageBytes>4194304) throw Error('Viewport exceeds 4 MiB'); console.log('viewport captured')`,
      )
      const image = await readFile(screenshot)
      expect(image.length).toBeLessThanOrEqual(4 * 1024 * 1024)
      expect(image.subarray(0, 4)).toEqual(Buffer.from([137, 80, 78, 71]))
      expect(
        (
          await execute(
            'await state.page.getByText("Scroll marker",{exact:true}).scrollIntoViewIfNeeded(); console.log(await state.page.evaluate(()=>window.scrollY>0))',
          )
        ).stdout,
      ).toContain('true')
      const logs = await execute(
        'console.log(JSON.stringify(await getLatestLogs({page:state.page,count:20})).slice(0,4096))',
      )
      expect(Buffer.byteLength(logs.stdout)).toBeLessThanOrEqual(4096)
      const selected = await execute(
        'state.response=state.page.waitForResponse(r=>new URL(r.url()).pathname==="/json"); await state.page.getByRole("button",{name:"Load JSON",exact:true}).click(); const body=await (await state.response).body(); if(body.length>65536) throw Error("Selected body exceeds 64 KiB"); console.log(body.toString().slice(0,8192))',
      )
      expect(selected.stdout).toContain(test.fixture.nonce)
      expect(Buffer.byteLength(selected.stdout)).toBeLessThanOrEqual(8192)
      const oversized = await execute(
        'state.response=state.page.waitForResponse(r=>new URL(r.url()).pathname==="/oversized"); await state.page.getByRole("button",{name:"Load oversized JSON",exact:true}).click(); const body=await (await state.response).body(); console.log(body.length>65536?"Selected body exceeds 64 KiB":"unexpected small body")',
      )
      expect(oversized.stdout).toContain('exceeds 64 KiB')
      const unavailable = await execute(
        'state.cdp=await getCDPSession({page:state.page}); await state.cdp.send("Network.enable",{maxTotalBufferSize:64,maxResourceBufferSize:32}); state.evictedId=null; state.cdp.on("Network.responseReceived",e=>{if(new URL(e.response.url).pathname==="/evicted")state.evictedId=e.requestId}); state.evictedDone=new Promise(ok=>state.cdp.on("Network.loadingFinished",e=>{if(e.requestId===state.evictedId)ok()})); await state.page.getByRole("button",{name:"Load evicted JSON",exact:true}).click(); await state.evictedDone; try{await state.cdp.send("Network.getResponseBody",{requestId:state.evictedId}); console.log("unexpected body")}catch{console.log("Selected body unavailable") }',
      )
      expect(unavailable.stdout).toContain('Selected body unavailable')
      for (const path of ['/json', '/oversized', '/evicted']) expect(test.fixture.requests[path]).toBe(1)
      expect(
        (
          await execute(
            'await state.page.getByRole("link",{name:"Navigate fixture"}).click(); console.log(state.page.url().endsWith("/next"))',
          )
        ).stdout,
      ).toContain('true')
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
      await report('passed')
    } catch (error) {
      await report('failed')
      throw error
    } finally {
      child?.kill()
      await test.cleanup()
      if (!relocated.startsWith(join(tmpdir(), 'playwriter-derp-delivery-')))
        throw new Error('Unexpected delivery directory')
      await rm(relocated, { recursive: true, force: true })
    }
  },
  300_000,
)
