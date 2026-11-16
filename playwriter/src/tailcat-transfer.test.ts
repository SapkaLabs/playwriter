import { it, expect } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setupTailcatTest, tailcatTestsEnabled } from './tailcat-test-utils.js'

it.runIf(tailcatTestsEnabled)(
  'transfers bounded synthetic responses over the real public byte stream',
  async () => {
    const test = await setupTailcatTest()
    // The final small record checks that a large completed response does not
    // leave the following command stalled behind ingress/backpressure state.
    const sizes = [16, 65535, 65536, 65537, 262144, 1048576, 16]
    const report: { [key: string]: unknown } = { at: new Date().toISOString(), samples: [] }
    await mkdir(resolve('../tmp/evidence'), { recursive: true })
    const save = () => writeFile(resolve('../tmp/evidence/transfer.json'), JSON.stringify(report, null, 2) + '\n')
    let connection: Awaited<ReturnType<typeof test.connect>> | undefined
    try {
      connection = await test.connect(await test.start())
      await test.execute(connection, 'state.cdp=await getCDPSession({page:context.pages()[0]})')
      for (const size of sizes) {
        const started = performance.now()
        const result = await test.execute(
          connection,
          `const response=await state.cdp.send('Runtime.evaluate',{expression:'"A".repeat(${size})',returnByValue:true}); console.log(response.result.value.length)`,
        )
        expect(result.stdout).toContain(String(size))
        ;(report.samples as unknown[]).push({ bytes: size, ms: performance.now() - started })
        await save()
      }
      report.result = 'passed'
      await save()
    } catch (error) {
      report.result = 'failed'
      report.failures = connection?.failures.map((reason) =>
        reason.startsWith('Fixture') ? reason : 'Transport failure',
      )
      report.controllerTrace = connection?.trace
      report.browserTrace = await test.testControl('trace').catch(() => [])
      await save()
      throw error
    } finally {
      await test.cleanup()
    }
  },
  300_000,
)
