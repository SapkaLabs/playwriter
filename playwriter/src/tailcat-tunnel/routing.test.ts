import { it, expect } from 'vitest'
import { setupTailcatTest, tailcatTestsEnabled } from './test-utils.js'

it.runIf(tailcatTestsEnabled)(
  'switches A to B and back, allowing retries only inside the frozen selected region',
  async () => {
    const test = await setupTailcatTest()
    const request = (action: string, data: object = {}) =>
      test.control.evaluate(({ action, data }) => chrome.runtime.sendMessage({ action, ...data }), { action, data })
    const urls = ['https://route-a.example/map', 'https://route-b.example/map']
    try {
      let { profiles } = await request('tailcatProfiles')
      for (const [index, url] of urls.entries()) {
        const nodes = ['first', 'second'].map((part) => ({
          RegionID: 900,
          Name: part,
          HostName: `${part}-${index}.example`,
          DERPPort: 8443,
        }))
        await test.testControl('mapFixture', {
          url,
          fixture: {
            body: JSON.stringify({
              Regions: {
                '900': { RegionID: 900, Nodes: nodes },
                '901': {
                  RegionID: 901,
                  Nodes: [{ RegionID: 901, Name: 'forbidden', HostName: 'other-region.example' }],
                },
              },
            }),
          },
        })
        ;({ profiles } = await request('tailcatProfileUpdate', {
          change: { action: 'add', name: `Route${index}`, derpMapURL: url, expectedRevision: profiles.revision },
        }))
      }
      let previousShare = ''
      for (const index of [0, 1, 0]) {
        ;({ profiles } = await request('tailcatProfiles'))
        const id = profiles.profiles.find((p: any) => p.name === `Route${index}`).id
        await request('tailcatProfileUpdate', {
          stopActive: true,
          change: { action: 'select', id, expectedRevision: profiles.revision },
        })
        expect((await request('tailcatStatus')).descriptor).toBe('')
        await test.control.getByRole('button', { name: 'Start sharing', exact: true }).click()
        await expect.poll(async () => (await request('tailcatStatus')).descriptor, { timeout: 10_000 }).not.toBe('')
        const descriptor = JSON.parse((await request('tailcatStatus')).descriptor)
        expect(descriptor.regionId).toBe(900)
        expect(descriptor.shareId).not.toBe(previousShare)
        previousShare = descriptor.shareId
        const attempts = async () => (await test.testControl('trace')).filter((e: any) => e.stage === 'derp-construct')
        await expect.poll(async () => (await attempts()).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
        expect(
          (await attempts()).every((e: any) =>
            [`wss://first-${index}.example:8443`, `wss://second-${index}.example:8443`].includes(e.endpoint),
          ),
        ).toBe(true)
        await expect.poll(() => test.control.getByRole('status').textContent()).toContain('disconnected')
      }
      await test.stop()
      expect(await test.testControl('mapRequests')).toEqual([urls[0], urls[1], urls[0]])
    } finally {
      await test.cleanup()
    }
  },
  90_000,
)
