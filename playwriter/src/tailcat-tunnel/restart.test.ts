import { it, expect } from 'vitest'
import { setupTailcatTest, tailcatTestsEnabled } from './test-utils.js'

it.runIf(tailcatTestsEnabled).each(['background', 'extension', 'browser'] as const)(
  'revokes sharing across an actual %s restart without restoring the old descriptor',
  async (mode) => {
    const test = await setupTailcatTest()
    try {
      const old = await test.start()
      const connection = await test.connect(old)
      await test.restart(mode)
      await expect.poll(() => test.control.getByRole('status').textContent(), { timeout: 10_000 }).toContain('stopped')
      expect(await test.control.getByLabel('Connection information').inputValue()).toBe('')
      await expect(test.execute(connection, 'console.log(await context.pages()[0].title())')).rejects.toThrow()
      await connection.close()
      await expect(test.connect(old)).rejects.toThrow()
      const positive = await test.connect(await test.start())
      expect((await test.execute(positive, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
      await positive.close()
      await expect(test.connect(old)).rejects.toThrow()
    } finally {
      await test.cleanup()
    }
  },
  180_000,
)
