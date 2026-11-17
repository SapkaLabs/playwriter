import { it, expect } from 'vitest'
import { setupTailcatTest, tailcatTestsEnabled } from './test-utils.js'

it.runIf(tailcatTestsEnabled)(
  'keeps old settings but revokes sharing when an active edit cannot be persisted',
  async () => {
    const test = await setupTailcatTest()
    try {
      await test.start()
      const worker = test.context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'))!
      await worker.evaluate(() => {
        const save = chrome.storage.local.set.bind(chrome.storage.local)
        ;(globalThis as any).restoreProfileWrite = () => {
          chrome.storage.local.set = save
        }
        chrome.storage.local.set = (async (value: any) => {
          if ('tailcatProfiles' in value) throw new Error('Injected persistence failure')
          return save(value)
        }) as typeof chrome.storage.local.set
      })
      const result = await test.control.evaluate(async () => {
        const { profiles } = await chrome.runtime.sendMessage({ action: 'tailcatProfiles' })
        const response = await chrome.runtime.sendMessage({
          action: 'tailcatProfileUpdate',
          stopActive: true,
          change: {
            action: 'edit',
            id: profiles.selectedProfileId,
            name: 'Not saved',
            expectedRevision: profiles.revision,
          },
        })
        return {
          response,
          before: profiles,
          after: (await chrome.runtime.sendMessage({ action: 'tailcatProfiles' })).profiles,
          state: await chrome.runtime.sendMessage({ action: 'tailcatStatus' }),
        }
      })
      expect(result.response.error).toContain('CONFIG_WRITE_FAILED')
      expect(result.after).toEqual(result.before)
      expect(result.state).toMatchObject({ active: false, descriptor: '', status: 'stopped' })
      await worker.evaluate(() => (globalThis as any).restoreProfileWrite())
      await test.start()
      await test.stop()
    } finally {
      await test.cleanup()
    }
  },
  60_000,
)

it.runIf(tailcatTestsEnabled)(
  'uses public DERP through saved profiles and v2 agreement, then explicitly switches without starting',
  async () => {
    const test = await setupTailcatTest()
    try {
      const page = test.control
      await page.getByText('Manage servers', { exact: true }).click()
      await page.getByRole('button', { name: 'Add server', exact: true }).click()
      await page.getByLabel('Name', { exact: true }).fill('Public alias')
      await page.getByLabel('DERP map URL', { exact: true }).fill('https://tailcat.dev/derpmap.json')
      await page.getByRole('button', { name: 'Save server', exact: true }).click()
      await expect.poll(() => page.locator('#server option').allTextContents()).toContain('Public alias')
      const first = await test.start()
      expect(first.v).toBe(2)
      const connection = await test.connect(first)
      expect((await test.execute(connection, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
      await test.execute(connection, 'state.cdp=await getCDPSession({page:context.pages()[0]})')
      await test.testControl('barrierArm', { name: 'dispatch', method: 'Runtime.evaluate' })
      const held = test.execute(
        connection,
        `await state.cdp.send('Runtime.evaluate',{expression:'document.getElementById("count").click()'})`,
      )
      void held.catch(() => {})
      await expect
        .poll(() => test.testControl('barrierStatus', { name: 'dispatch' }), { timeout: 15_000 })
        .toMatchObject({ blocked: 1 })
      await page.getByLabel('Server', { exact: true }).selectOption({ label: 'Public alias' })
      await page.getByRole('button', { name: 'Stop and select', exact: true }).click()
      await expect.poll(() => page.getByRole('status').textContent()).toBe('stopped')
      expect(await page.getByLabel('Connection information').inputValue()).toBe('')
      expect(await page.getByLabel('Server', { exact: true }).locator('option:checked').textContent()).toBe(
        'Public alias',
      )
      const second = await test.start()
      expect(second.shareId).not.toBe(first.shareId)
      await test.testControl('barrierRelease', { name: 'dispatch' })
      await connection.close()
      await expect(held).rejects.toThrow()
      const positive = await test.connect(second)
      expect((await test.execute(positive, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
      expect(
        (
          await test.execute(
            positive,
            'console.log(JSON.stringify(await context.pages()[0].evaluate(()=>window.fixtureHistory)))',
          )
        ).stdout,
      ).toContain('[]')
      await positive.close()
      await test.stop()
      // This is alias/configuration and revocation evidence, not independent-server switching.
    } finally {
      await test.cleanup()
    }
  },
  180_000,
)

it.runIf(tailcatTestsEnabled)(
  'isolates disjoint synthetic maps with the same region ID and never contacts Public on failure',
  async () => {
    const test = await setupTailcatTest()
    const maps = ['https://map-a.example/map', 'https://map-b.example/map']
    const relay = (host: string) =>
      JSON.stringify({
        Regions: {
          '900': {
            RegionID: 900,
            Nodes: [{ RegionID: 900, Name: 'node', HostName: host, hostname: 'forbidden.example', DERPPort: 8443 }],
          },
        },
      })
    const request = (action: string, data: object = {}) =>
      test.control.evaluate(({ action, data }) => chrome.runtime.sendMessage({ action, ...data }), { action, data })
    try {
      for (let i = 0; i < maps.length; i++)
        await test.testControl('mapFixture', {
          url: maps[i],
          fixture: { body: relay(`relay-${i ? 'b' : 'a'}.example`) },
        })
      let { profiles } = await request('tailcatProfiles')
      for (let i = 0; i < maps.length; i++)
        ({ profiles } = await request('tailcatProfileUpdate', {
          change: { action: 'add', name: `Fixture${i}`, derpMapURL: maps[i], expectedRevision: profiles.revision },
        }))
      const a = profiles.profiles.find((p: any) => p.name === 'Fixture0'),
        b = profiles.profiles.find((p: any) => p.name === 'Fixture1')
      await request('tailcatProfileUpdate', {
        change: { action: 'select', id: a.id, expectedRevision: profiles.revision },
      })
      const syntheticStart = async () => {
        await test.control.getByRole('button', { name: 'Start sharing', exact: true }).click()
        await expect.poll(async () => (await request('tailcatStatus')).descriptor, { timeout: 10_000 }).not.toBe('')
        return JSON.parse((await request('tailcatStatus')).descriptor)
      }
      const first = await syntheticStart()
      expect(first.regionId).toBe(900)
      await expect
        .poll(async () =>
          (await test.testControl('trace'))
            .filter((e: any) => e.stage === 'derp-construct')
            .map((e: any) => e.endpoint),
        )
        .toContain('wss://relay-a.example:8443')
      await test.control.getByLabel('Server', { exact: true }).selectOption({ label: 'Fixture1' })
      await test.control.getByRole('button', { name: 'Stop and select', exact: true }).click()
      await expect.poll(() => test.control.getByRole('status').textContent()).toBe('stopped')
      const second = await syntheticStart()
      expect(second.derpMapSha256).not.toBe(first.derpMapSha256)
      await expect
        .poll(async () =>
          (await test.testControl('trace'))
            .filter((e: any) => e.stage === 'derp-construct')
            .map((e: any) => e.endpoint),
        )
        .toContain('wss://relay-b.example:8443')
      const sockets = (await test.testControl('trace')).filter((e: any) => e.stage === 'derp-construct')
      expect(sockets.every((e: any) => e.endpoint === 'wss://relay-b.example:8443')).toBe(true)
      await test.stop()
      await test.testControl('mapFixture', { url: maps[1], fixture: { body: '{bad' } })
      await test.control.getByRole('button', { name: 'Start sharing', exact: true }).click()
      await expect
        .poll(
          async () => ({ state: await request('tailcatStatus'), requests: await test.testControl('mapRequests') }),
          { timeout: 15_000 },
        )
        .toMatchObject({ state: { status: 'failed', error: expect.stringContaining('MAP_INVALID') } })
      await expect.poll(() => test.control.getByRole('status').textContent()).toContain('MAP_INVALID')
      expect(await test.control.getByLabel('Connection information').inputValue()).toBe('')
      expect(await test.control.getByRole('button', { name: 'Start sharing', exact: true }).isEnabled()).toBe(true)
      expect(await test.testControl('mapRequests')).toEqual([maps[0], maps[1], maps[1]])
      await test.stop()
    } finally {
      await test.cleanup()
    }
  },
  90_000,
)

it.runIf(tailcatTestsEnabled)(
  'reserves startup once, permits Stop with a blocked map, and fails timeout without fallback',
  async () => {
    const test = await setupTailcatTest()
    const request = (action: string, data: object = {}) =>
      test.control.evaluate(({ action, data }) => chrome.runtime.sendMessage({ action, ...data }), { action, data })
    const url = 'https://slow.example/map'
    try {
      await test.testControl('mapFixture', { url, fixture: { body: '', hang: true } })
      let { profiles } = await request('tailcatProfiles')
      ;({ profiles } = await request('tailcatProfileUpdate', {
        change: { action: 'add', name: 'Slow', derpMapURL: url, expectedRevision: profiles.revision },
      }))
      await request('tailcatProfileUpdate', {
        change: {
          action: 'select',
          id: profiles.profiles.find((p: any) => p.name === 'Slow').id,
          expectedRevision: profiles.revision,
        },
      })
      const results = await test.control.evaluate(async () => {
        const tabs = await chrome.tabs.query({})
        const tabId = tabs.find((t) => t.url?.startsWith('http://127.0.0.1:'))!.id
        return Promise.all([
          chrome.runtime.sendMessage({ action: 'tailcatStart', tabId }),
          chrome.runtime.sendMessage({ action: 'tailcatStart', tabId }),
        ])
      })
      expect(results.filter((r) => r.error)).toHaveLength(1)
      await expect.poll(() => test.testControl('mapRequests')).toEqual([url])
      await test.stop()
      expect((await request('tailcatStatus')).descriptor).toBe('')
      await test.control.getByRole('button', { name: 'Start sharing', exact: true }).click()
      await expect
        .poll(() => request('tailcatStatus'), { timeout: 15_000 })
        .toMatchObject({ status: 'failed', error: expect.stringContaining('MAP_TIMEOUT'), active: false })
      expect(await test.testControl('mapRequests')).toEqual([url, url])
      await test.stop()
      // No anchor/toolbar is required to revoke or dismiss the failed attempt.
      await test.context.pages()[0].close()
      await test.stop()
    } finally {
      await test.cleanup()
    }
  },
  40_000,
)

it.runIf(tailcatTestsEnabled)(
  'cancels a switch and revokes active profile edits and deletion before saving',
  async () => {
    const test = await setupTailcatTest()
    const page = test.control
    try {
      const first = await test.start()
      const active = await test.connect(first)
      await page.getByLabel('Server', { exact: true }).selectOption('')
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect((await test.execute(active, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
      await page.getByText('Manage servers', { exact: true }).click()
      await page.getByRole('button', { name: 'Edit server', exact: true }).click()
      await page.getByLabel('Name', { exact: true }).fill('Renamed')
      await page.getByRole('button', { name: 'Save server', exact: true }).click()
      await page.getByRole('button', { name: 'Stop and save', exact: true }).click()
      await expect.poll(() => page.getByRole('status').textContent()).toBe('stopped')
      await expect(test.execute(active, 'console.log(await context.pages()[0].title())', 1000)).rejects.toThrow()
      await expect.poll(() => active.isTerminal(), { timeout: 5000 }).toBe(true)
      const fresh = await test.start()
      expect(fresh.shareId).not.toBe(first.shareId)
      await page.getByRole('button', { name: 'Remove server', exact: true }).click()
      await page.getByRole('button', { name: 'Stop and remove', exact: true }).click()
      await expect.poll(() => page.getByRole('status').textContent()).toBe('stopped')
      expect(await page.getByLabel('Server', { exact: true }).inputValue()).toBe('')
      await test.restart('browser')
      await expect.poll(() => test.control.locator('#server option').allTextContents()).toEqual(['Select a server'])
    } finally {
      await test.cleanup()
    }
  },
  90_000,
)

it.runIf(tailcatTestsEnabled)(
  'rejects forged session metadata and a second controller without displacing its owner',
  async () => {
    const test = await setupTailcatTest()
    try {
      const descriptor = await test.start()
      await expect(test.connect({ ...descriptor, shareId: '0'.repeat(32) })).rejects.toThrow('SESSION_MISMATCH')
      const incumbent = await test.connect(descriptor)
      await expect(test.connect(descriptor)).rejects.toThrow()
      expect((await test.execute(incumbent, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
      await incumbent.close()
      const next = await test.connect(descriptor)
      expect((await test.execute(next, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
      await test.stop()
    } finally {
      await test.cleanup()
    }
  },
  90_000,
)
