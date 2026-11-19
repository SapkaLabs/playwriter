import { it, expect } from 'vitest'
import { setupTailcatTest, tailcatTestsEnabled } from './test-utils.js'

// Supply a retained, unmodified public-MVP extension artifact. This deliberately
// tests its real v1 descriptor/hello, not a relabelled v2 descriptor.
it.runIf(tailcatTestsEnabled && !!process.env.PLAYWRITER_TAILCAT_LEGACY_EXTENSION)(
  'connects the new controller to the legacy public extension without v2 metadata',
  async () => {
    const test = await setupTailcatTest({ extensionDirectory: process.env.PLAYWRITER_TAILCAT_LEGACY_EXTENSION })
    try {
      const descriptor = await test.start()
      expect(descriptor.v).toBe(1)
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
