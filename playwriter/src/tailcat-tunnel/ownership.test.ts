import { it, expect } from 'vitest'
import { setupTailcatTest, tailcatTestsEnabled } from './test-utils.js'

it.runIf(tailcatTestsEnabled)(
  'reserves the controller slot before its hello and keeps Stop available during switch confirmation',
  async () => {
    const test = await setupTailcatTest()
    try {
      const descriptor = await test.start()
      await test.testControl('barrierArm', { name: 'preface' })
      const pending = test.connect(descriptor)
      void pending.catch(() => {})
      await expect
        .poll(() => test.testControl('barrierStatus', { name: 'preface' }), { timeout: 10_000 })
        .toMatchObject({ blocked: 1 })
      await expect(test.connect(descriptor)).rejects.toThrow()
      await test.testControl('barrierRelease', { name: 'preface' })
      const owner = await pending
      expect((await test.execute(owner, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
      await test.control.getByLabel('Server', { exact: true }).selectOption('')
      await test.control.getByRole('button', { name: 'Stop and select', exact: true }).waitFor()
      await test.stop()
      await test.control.getByRole('button', { name: 'Cancel', exact: true }).click()
      expect(await test.control.getByLabel('Connection information').inputValue()).toBe('')
      expect(await test.control.getByLabel('Server', { exact: true }).inputValue()).not.toBe('')
      await owner.close()
      const fresh = await test.connect(await test.start())
      expect((await test.execute(fresh, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
      await test.stop()
    } finally {
      await test.testControl('barrierRelease', { name: 'preface' }).catch(() => {})
      await test.cleanup()
    }
  },
  90_000,
)
