import { it, expect } from 'vitest'
import { setupTailcatTest, tailcatTestsEnabled } from './tailcat-test-utils.js'

// Test-only mutation of the pinned upstream short-address CBOR shape. Never
// print the bytes: even a negative address carries the share's bearer secret.
function mutateAddress(addr: string, field: 'p' | 'q', mutation: 'flip' | 'zero' | 'remove'): string {
  const bytes = Buffer.from(addr.slice(2), 'base64url')
  const marker = Buffer.from([0x61, field.charCodeAt(0), 0x58, 0x20])
  const offset = bytes.indexOf(marker)
  if (offset < 1 || bytes.lastIndexOf(marker) !== offset || bytes[0] < 0xa1 || bytes[0] > 0xb7) {
    throw new Error('Pinned short-address encoding changed')
  }
  if (mutation === 'remove') {
    const result = Buffer.concat([bytes.subarray(0, offset), bytes.subarray(offset + 36)])
    result[0]--
    return 'tc' + result.toString('base64url')
  }
  if (mutation === 'zero') bytes.fill(0, offset + 4, offset + 36)
  else bytes[offset + 4] ^= 1
  return 'tc' + bytes.toString('base64url')
}

it.runIf(tailcatTestsEnabled)(
  'rejects missing/zero/wrong PSKs and a substituted server key, with a real positive control',
  async () => {
    const test = await setupTailcatTest()
    try {
      const descriptor = await test.start()
      for (const mutation of ['remove', 'zero'] as const) {
        await expect(
          test.connect({ ...descriptor, addr: mutateAddress(descriptor.addr, 'q', mutation) }),
        ).rejects.toThrow('nonzero PSK')
      }
      for (const field of ['q', 'p'] as const) {
        await expect(
          test.connect({ ...descriptor, addr: mutateAddress(descriptor.addr, field, 'flip') }),
        ).rejects.toThrow()
      }
      const positive = await test.connect(descriptor)
      expect((await test.execute(positive, 'console.log(await context.pages()[0].title())')).stdout).toContain(
        'DERP fixture',
      )
      await test.stop()
    } finally {
      await test.cleanup()
    }
  },
  180_000,
)
