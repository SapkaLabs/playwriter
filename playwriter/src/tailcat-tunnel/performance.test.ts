import { it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setupTailcatTest, tailcatTestsEnabled } from './test-utils.js'

// Windows acceptance measurement, not a performance threshold or a production
// keepalive. The sharing page is closed for the entire ten-minute idle period.
it.runIf(tailcatTestsEnabled && process.env.PLAYWRITER_TAILCAT_MEASURE === '1' && process.platform === 'win32')(
  'measures startup, operation latency and memory over ten minutes idle',
  async () => {
    const test = await setupTailcatTest()
    const browserCDP = await test.context.browser()!.newBrowserCDPSession()
    const report: { [key: string]: unknown } = {
      at: new Date().toISOString(),
      browser: test.context.browser()!.version(),
      platform: process.platform,
      node: process.version,
      idleControlPage: 'closed',
      samples: [],
    }
    const output = resolve('../tmp/evidence/performance.json')
    await mkdir(resolve('../tmp/evidence'), { recursive: true })
    const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
    const memory = async (extra: number[] = []) => {
      const { processInfo } = await browserCDP.send('SystemInfo.getProcessInfo')
      const browserIds = processInfo.map((info) => info.id)
      const ids = [...new Set([...browserIds, ...extra])]
      if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid owned process identity')
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,PrivateMemorySize64,WorkingSet64 | ConvertTo-Json -Compress`,
        ],
        { windowsHide: true, timeout: 10_000 },
      )
      const parsed = JSON.parse(stdout),
        processes = Array.isArray(parsed) ? parsed : [parsed]
      const sum = (selected: number[], field: string) =>
        processes.filter((p) => selected.includes(p.Id)).reduce((total, p) => total + p[field], 0)
      return {
        at: new Date().toISOString(),
        browserPrivateBytes: sum(browserIds, 'PrivateMemorySize64'),
        browserWorkingSetBytes: sum(browserIds, 'WorkingSet64'),
        controllerPrivateBytes: sum(extra, 'PrivateMemorySize64'),
        adapterRSS: process.memoryUsage().rss,
      }
    }
    try {
      report.beforeShare = await memory()
      const cold = performance.now(),
        descriptor = await test.start()
      const first = await test.connect(descriptor)
      report.coldStartMs = performance.now() - cold
      let start = performance.now()
      expect((await test.execute(first, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
      report.coldReadMs = performance.now() - start
      await first.close()
      await test.testControl('dispose')
      start = performance.now()
      const warm = await test.connect(descriptor)
      report.warmConnectMs = performance.now() - start
      start = performance.now()
      expect((await test.execute(warm, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
      report.warmReadMs = performance.now() - start
      const owned = [warm.nativePid, warm.relayPid!]
      report.connected = await memory(owned)
      await test.control.close()
      const idleStart = performance.now()
      for (let minute = 1; minute <= 10; minute++) {
        await new Promise((ok) => setTimeout(ok, 60_000))
        const sample = { minute, ...(await memory(owned)), terminal: warm.isTerminal() }
        ;(report.samples as unknown[]).push(sample)
        await save()
        console.log(
          JSON.stringify({
            stage: 'idle-minute',
            minute,
            terminal: sample.terminal,
            browserPrivateBytes: sample.browserPrivateBytes,
          }),
        )
      }
      report.idleMs = performance.now() - idleStart
      start = performance.now()
      const read = await test.execute(warm, 'console.log(await context.pages()[0].title())')
      report.afterIdleReadMs = performance.now() - start
      expect(read.stdout).toContain('DERP fixture')
      await test.openControl()
      await expect.poll(() => test.control.getByRole('status').textContent()).toContain('connected')
      report.afterIdleStatus = await test.control.getByRole('status').textContent()
      await test.stop()
      report.result = 'passed'
      await save()
    } catch (error) {
      report.result = 'failed'
      report.failure = error instanceof Error ? error.message : 'Measurement failed'
      await save()
      throw error
    } finally {
      await browserCDP.detach().catch(() => {})
      await test.cleanup()
    }
  },
  720_000,
)
