import { it, expect } from 'vitest'
import { setupTailcatTest, tailcatTestsEnabled } from './tailcat-test-utils.js'

it.runIf(tailcatTestsEnabled)(
  'does not log a remote-controlled URL in the extension console',
  async () => {
    const test = await setupTailcatTest()
    const marker = 'private-fixture-marker-7a3548'
    let leaked = false
    test.context.on('console', (message) => {
      if (
        message.worker()?.url().startsWith('chrome-extension://pebbngnfojnignonigcnkdilknapkgid/') &&
        message.text().includes(marker)
      )
        leaked = true
    })
    try {
      const connection = await test.connect(await test.start())
      await test.execute(
        connection,
        `state.cdp=await getCDPSession({page:context.pages()[0]}); await state.cdp.send('Target.createTarget',{url:${JSON.stringify(test.fixture.url + '?' + marker)}})`,
      )
      await test.stop()
      expect(leaked).toBe(false)
    } finally {
      await test.cleanup()
    }
  },
  90_000,
)
