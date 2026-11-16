import { describe, it, expect } from 'vitest'
import { setupTailcatTest, tailcatTestsEnabled } from './tailcat-test-utils.js'

describe.runIf(tailcatTestsEnabled)('public DERP lifecycle and no replay', () => {
  it('rejects a stale dispatch continuation after Stop without a click effect', async () => {
    const test = await setupTailcatTest()
    try {
      const connection = await test.connect(await test.start())
      await test.execute(connection, 'state.cdp=await getCDPSession({page:context.pages()[0]})')
      await test.testControl('barrierArm', { name: 'dispatch', method: 'Runtime.evaluate' })
      const action = test.execute(
        connection,
        `await state.cdp.send("Runtime.evaluate",{expression:${JSON.stringify('document.getElementById("count").click()')}})`,
      )
      void action.catch(() => {})
      await expect
        .poll(() => test.testControl('barrierStatus', { name: 'dispatch' }), { timeout: 15_000 })
        .toMatchObject({ blocked: 1 })
      await test.stop()
      await test.testControl('barrierRelease', { name: 'dispatch' })
      await expect(action).rejects.toThrow()
      const fresh = await test.connect(await test.start())
      expect(
        (
          await test.execute(
            fresh,
            'console.log(JSON.stringify(await context.pages()[0].evaluate(()=>window.fixtureHistory)))',
          )
        ).stdout,
      ).toContain('[]')
    } finally {
      await test.cleanup()
    }
  }, 90_000)
  it.each(['screenshot', 'JSON'])(
    'fails a partial %s transfer without a replacement operation',
    async (kind) => {
      const test = await setupTailcatTest()
      try {
        const connection = await test.connect(await test.start())
        await test.execute(
          connection,
          'state.page=context.pages()[0]; state.cdp=await getCDPSession({page:state.page})',
        )
        if (kind === 'JSON') {
          await test.execute(
            connection,
            'state.cdp.on("Network.responseReceived",e=>{if(e.response.url.includes("/transfer"))state.requestId=e.requestId}); await state.cdp.send("Network.enable"); await state.page.evaluate(()=>fetch("/transfer").then(r=>r.json()))',
          )
        }
        await test.testControl('barrierArm', { name: 'transfer' })
        const action = test.execute(
          connection,
          kind === 'screenshot'
            ? 'await state.cdp.send("Page.captureScreenshot",{format:"png"}); console.log("complete")'
            : 'await state.cdp.send("Network.getResponseBody",{requestId:state.requestId}); console.log("complete")',
        )
        void action.catch(() => {})
        await expect
          .poll(() => test.testControl('barrierStatus', { name: 'transfer' }), { timeout: 15_000 })
          .toMatchObject({ blocked: 1 })
        await test.stop()
        await test.testControl('barrierRelease', { name: 'transfer' })
        await expect(action).rejects.toThrow()
        expect(connection.isTerminal()).toBe(true)
        const method = kind === 'screenshot' ? 'Page.captureScreenshot' : 'Network.getResponseBody'
        expect(
          connection.trace.filter((frame) => frame.direction === 'write' && frame.cdpMethod === method),
        ).toHaveLength(1)
        const fresh = await test.connect(await test.start())
        expect((await test.execute(fresh, 'console.log(await context.pages()[0].title())')).stdout).toContain(
          'DERP fixture',
        )
        if (kind === 'JSON') expect(test.fixture.requests['/transfer']).toBe(1)
      } finally {
        await test.cleanup()
      }
    },
    90_000,
  )
  it('revokes on transport-worker loss and rejects the old descriptor around a fresh positive control', async () => {
    const test = await setupTailcatTest()
    try {
      const old = await test.start()
      const connection = await test.connect(old)
      await test.testControl('workerLoss')
      await expect.poll(() => test.control.getByRole('status').textContent()).toContain('stopped')
      await expect(test.execute(connection, 'console.log(await context.pages()[0].title())')).rejects.toThrow()
      await expect.poll(() => connection.isTerminal(), { timeout: 5000 }).toBe(true)
      await expect(test.connect(old)).rejects.toThrow()
      const fresh = await test.connect(await test.start())
      expect((await test.execute(fresh, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
      await fresh.close()
      await expect(test.connect(old)).rejects.toThrow()
    } finally {
      await test.cleanup()
    }
  }, 180_000)
  it('keeps a fresh share alive when a cancelled anchor startup resumes', async () => {
    const test = await setupTailcatTest()
    try {
      await test.testControl('barrierArm', { name: 'anchor-attach' })
      await test.control.getByRole('button', { name: 'Start sharing', exact: true }).click()
      await expect
        .poll(() => test.testControl('barrierStatus', { name: 'anchor-attach' }), { timeout: 15_000 })
        .toMatchObject({ blocked: 1 })
      await test.stop()
      await test.start()
      await test.testControl('barrierRelease', { name: 'anchor-attach' })
      await expect.poll(() => test.control.getByRole('status').textContent(), { timeout: 5000 }).toContain('ready')
      const connection = await test.connect(
        JSON.parse(await test.control.getByLabel('Connection information').inputValue()),
      )
      expect((await test.execute(connection, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
    } finally {
      await test.cleanup()
    }
  }, 90_000)
  it('reports an unknown click outcome after its effect but before its held response, with no replay', async () => {
    const test = await setupTailcatTest()
    try {
      const connection = await test.connect(await test.start())
      await test.execute(connection, 'state.page=context.pages()[0]; state.cdp=await getCDPSession({page:state.page})')
      await test.testControl('barrierArm', { name: 'response', method: 'Runtime.evaluate' })
      const click = test.execute(
        connection,
        `await state.cdp.send("Runtime.evaluate",{expression:${JSON.stringify('document.getElementById("count").click()')}}); console.log("acknowledged")`,
      )
      void click.catch(() => {})
      await expect
        .poll(() => test.testControl('barrierStatus', { name: 'response' }), { timeout: 15_000 })
        .toMatchObject({ blocked: 1 })
      await connection.close()
      await expect(click).rejects.toThrow()
      expect(connection.failures.join(' ')).toContain('outcome unknown')
      await test.stop()
      await test.testControl('barrierRelease', { name: 'response' })
      const fresh = await test.connect(await test.start())
      const history = await test.execute(
        fresh,
        'console.log(JSON.stringify(await context.pages()[0].evaluate(()=>window.fixtureHistory)))',
      )
      expect(history.stdout.match(/"type":"click"/g)).toHaveLength(1)
    } finally {
      await test.cleanup()
    }
  }, 90_000)
  it('never writes or replays a click held before its native write when Stop wins', async () => {
    const test = await setupTailcatTest()
    let release = () => {}
    const held = new Promise<void>((ok) => {
      release = ok
    })
    let blocked = false
    try {
      const connection = await test.connect(await test.start(), {
        testBeforeWrite: async (frame) => {
          if (frame.cdpMethod === 'Input.dispatchMouseEvent') {
            blocked = true
            await held
          }
        },
      })
      await test.execute(
        connection,
        `state.page=context.pages().find(p=>p.url()===${JSON.stringify(test.fixture.url)})`,
      )
      const click = test.execute(
        connection,
        'await state.page.getByRole("button",{name:"Click counter",exact:true}).click()',
      )
      void click.catch(() => {})
      await expect.poll(() => blocked, { timeout: 15_000 }).toBe(true)
      await test.stop()
      await connection.close()
      release()
      await expect(click).rejects.toThrow()
      const fresh = await test.connect(await test.start())
      const observation = await test.execute(
        fresh,
        'console.log(JSON.stringify(await context.pages()[0].evaluate(()=>window.fixtureHistory)))',
      )
      expect(observation.stdout).toContain('[]')
    } finally {
      release()
      await test.cleanup()
    }
  }, 90_000)
  it('terminates its generation when the whole script times out without a pending CDP command', async () => {
    const test = await setupTailcatTest()
    try {
      const connection = await test.connect(await test.start())
      await expect(test.execute(connection, 'await new Promise(()=>{})', 250)).rejects.toThrow()
      await expect.poll(() => connection.isTerminal(), { timeout: 5000 }).toBe(true)
      expect(connection.failures.join(' ')).toContain('operation failed')
    } finally {
      await test.cleanup()
    }
  }, 90_000)
  it.each(['startup-before-listen', 'startup-after-descriptor'])(
    'Stop cancels %s without a late share resurrection',
    async (name) => {
      const test = await setupTailcatTest()
      try {
        await test.testControl('barrierArm', { name })
        await test.control.getByRole('button', { name: 'Start sharing', exact: true }).click()
        await expect
          .poll(() => test.testControl('barrierStatus', { name }), { timeout: 15_000 })
          .toMatchObject({ blocked: 1 })
        await test.stop()
        await test.testControl('barrierRelease', { name })
        expect(await test.control.getByLabel('Connection information').inputValue()).toBe('')
        const descriptor = await test.start()
        const connection = await test.connect(descriptor)
        expect((await test.execute(connection, 'console.log(await context.pages()[0].title())')).stdout).toContain(
          'DERP fixture',
        )
        await test.stop()
      } finally {
        await test.cleanup()
      }
    },
    90_000,
  )
  it('bounds a silent established stream preface to 10 seconds', async () => {
    const test = await setupTailcatTest()
    const abort = new AbortController()
    try {
      const descriptor = await test.start()
      await test.testControl('barrierArm', { name: 'preface' })
      let failed = false
      const connection = test.connect(descriptor, { signal: abort.signal })
      void connection.catch(() => {
        failed = true
      })
      await expect
        .poll(() => test.testControl('barrierStatus', { name: 'preface' }), { timeout: 15_000 })
        .toMatchObject({ blocked: 1 })
      await expect.poll(() => failed, { timeout: 12_000 }).toBe(true)
    } finally {
      abort.abort()
      await test.stop()
      await test.testControl('barrierRelease', { name: 'preface' })
      await test.cleanup()
    }
  }, 90_000)
  it('does not create a tab when window lookup resumes after Stop', async () => {
    const test = await setupTailcatTest()
    try {
      const descriptor = await test.start()
      const connection = await test.connect(descriptor)
      const before = test.context.pages().length
      await test.testControl('barrierArm', { name: 'create-tab' })
      const action = test.execute(connection, 'await context.newPage()')
      let actionError = ''
      void action.catch((error) => {
        actionError = error.stderr || error.message
      })
      await expect
        .poll(
          async () => {
            if (actionError) throw new Error(actionError + '; ' + connection.failures.join('; '))
            return await test.testControl('barrierStatus', { name: 'create-tab' })
          },
          { timeout: 15_000 },
        )
        .toMatchObject({ blocked: 1 })
      await test.stop()
      await test.testControl('barrierRelease', { name: 'create-tab' })
      await expect(action).rejects.toThrow()
      expect(test.context.pages()).toHaveLength(before)
    } finally {
      await test.cleanup()
    }
  }, 90_000)
})
