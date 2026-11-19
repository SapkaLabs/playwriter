import { describe, expect, it } from 'vitest'
import { FramedStream, PendingDataBudget } from './protocol.js'

describe('public Tailcat framed byte stream', () => {
  it('reports malformed JSON without copying its bytes into diagnostics', async () => {
    const errors: string[] = []
    const stream = new FramedStream({
      write: async () => {},
      onMessage: async () => {},
      onError: (error) => errors.push(error.message),
    })
    await stream.start()
    const bytes = new TextEncoder().encode('privateFixture')
    const wire = new Uint8Array(10 + bytes.length)
    wire.set([80, 87, 84, 67, 49, 10])
    new DataView(wire.buffer).setUint32(6, bytes.length)
    wire.set(bytes, 10)
    await stream.receive(wire)
    expect(errors.join(' ')).toContain('JSON')
    expect(errors.join(' ')).not.toContain('privateFixture')
    stream.close()
  })
  it('keeps diagnostic command names bounded independently of the record size', async () => {
    let diagnostic: unknown
    const stream = new FramedStream({
      write: async () => {},
      onMessage: async () => {},
      onError: () => {},
      onFrame: (frame) => {
        diagnostic = frame.cdpMethod
      },
    })
    await stream.start()
    await stream.receive(new Uint8Array([80, 87, 84, 67, 49, 10]))
    await stream.send(
      JSON.stringify({ id: 1, method: 'forwardCDPCommand', params: { method: 'Runtime.' + 'A'.repeat(200) } }),
    )
    expect(diagnostic).toBeUndefined()
    stream.close()
  })
  it('preserves a valid void response with only its request id', async () => {
    const sent: number[][] = []
    const stream = new FramedStream({
      write: async (bytes) => {
        sent.push([...bytes])
      },
      onMessage: async () => {},
      onError: () => {},
    })
    await stream.start()
    await stream.receive(new Uint8Array([80, 87, 84, 67, 49, 10]))
    await expect(stream.send('{"id":1}')).resolves.toBeUndefined()
    expect(sent.slice(1).flat()).toEqual([0, 0, 0, 8, 123, 34, 105, 100, 34, 58, 49, 125])
    stream.close()
  })
  it.each([
    { method: 'forwardCDPCommand', params: { method: 'Page.enable' } },
    { method: 'hello', params: { browser: 123 } },
    { method: 'hello', params: { remote: 'yes' } },
    { method: 'forwardCDPEvent', params: { method: 'Page.loadEventFired', sessionId: 123 } },
    { id: 1, method: 'forwardCDPCommand', params: { method: 'Page.enable', params: [] } },
    { id: 1, method: 'updateTabGroup', params: { from: 'a' } },
    { id: 1, method: 'closeTabsForKey', params: { key: 123 } },
    { method: 'setRecorderState', params: { recording: 'yes' } },
    { method: 'log', params: { level: 'debug', args: [123] } },
    { id: 1, method: 'ping' },
    { id: 1, method: 123, result: {} },
    { id: 1, error: { message: 'bad' } },
  ])('rejects a malformed protocol envelope %# in both directions', async (record) => {
    const errors: string[] = []
    let dispatched = false
    const json = JSON.stringify(record),
      bytes = new TextEncoder().encode(json)
    const stream = new FramedStream({
      write: async () => {},
      onMessage: async () => {
        dispatched = true
      },
      onError: (error) => errors.push(error.message),
    })
    await stream.start()
    await stream.receive(new Uint8Array([80, 87, 84, 67, 49, 10]))
    await expect(stream.send(json)).rejects.toThrow()
    stream.close()
    const incoming = new FramedStream({
      write: async () => {},
      onMessage: async () => {
        dispatched = true
      },
      onError: (error) => errors.push(error.message),
    })
    await incoming.start()
    const wire = new Uint8Array(10 + bytes.length)
    wire.set([80, 87, 84, 67, 49, 10])
    new DataView(wire.buffer).setUint32(6, bytes.length)
    wire.set(bytes, 10)
    await incoming.receive(wire)
    expect(errors.length).toBeGreaterThan(0)
    expect(dispatched).toBe(false)
    incoming.close()
  })
  it('shares one endpoint budget across framed queues and its bridge', async () => {
    const budget = new PendingDataBudget()
    const releaseBridge = budget.reserve(24 * 1024 * 1024)
    const stream = new FramedStream({ budget, write: async () => {}, onMessage: async () => {}, onError: () => {} })
    await stream.start()
    await stream.receive(new Uint8Array([80, 87, 84, 67, 49, 10]))
    const record = new TextEncoder().encode('{"id":1,"result":"' + 'x'.repeat(5 * 1024 * 1024) + '"}')
    await expect(stream.sendRecord(record)).rejects.toThrow('32 MiB')
    releaseBridge()
    stream.close()
  })
  it('writes no action bytes if its pre-write wait resumes after the generation closes', async () => {
    const writes: number[][] = []
    let release = () => {}
    const hold = new Promise<void>((ok) => {
      release = ok
    })
    let held = false
    const stream = new FramedStream({
      write: async (bytes) => {
        writes.push([...bytes])
      },
      onMessage: async () => {},
      onError: () => {},
      beforeWriteRecord: async () => {
        held = true
        await hold
      },
    })
    await stream.start()
    await stream.receive(new Uint8Array([80, 87, 84, 67, 49, 10]))
    const action = stream.send('{"method":"ping"}')
    await expect.poll(() => held).toBe(true)
    stream.close()
    release()
    await expect(action).rejects.toThrow('closed')
    expect(writes).toEqual([[80, 87, 84, 67, 49, 10]])
  })
  it('exchanges the exact v1 preface and reads a split Unicode extension record', async () => {
    const sent: number[][] = []
    const received: string[] = []
    const stream = new FramedStream({
      write: async (bytes) => {
        sent.push([...bytes])
      },
      onMessage: async (json) => {
        received.push(json)
      },
      onError: () => {},
    })
    await stream.start()
    expect(sent).toEqual([[80, 87, 84, 67, 49, 10]])
    // Golden bytes authored independently: {"id":1,"result":"ї"} = 22 UTF-8 bytes.
    const bytes = new Uint8Array([
      80, 87, 84, 67, 49, 10, 0, 0, 0, 22, 123, 34, 105, 100, 34, 58, 49, 44, 34, 114, 101, 115, 117, 108, 116, 34, 58,
      34, 209, 151, 34, 125,
    ])
    for (const byte of bytes) await stream.receive(new Uint8Array([byte]))
    expect(received).toEqual(['{"id":1,"result":"ї"}'])
    stream.close()
  })

  it.each([
    ['preface mismatch', [0], 'preface'],
    ['zero record', [80, 87, 84, 67, 49, 10, 0, 0, 0, 0], 'length'],
    ['oversized record', [80, 87, 84, 67, 49, 10, 1, 0, 0, 1], 'length'],
    ['invalid UTF-8', [80, 87, 84, 67, 49, 10, 0, 0, 0, 1, 255], 'encoded'],
    ['invalid JSON', [80, 87, 84, 67, 49, 10, 0, 0, 0, 1, 123], 'JSON'],
    ['invalid schema', [80, 87, 84, 67, 49, 10, 0, 0, 0, 2, 91, 93], 'record'],
  ])('fails closed on %s', async (_name, bytes, expected) => {
    const errors: string[] = []
    const stream = new FramedStream({
      write: async () => {},
      onMessage: async () => {
        throw new Error('must not dispatch')
      },
      onError: (error) => {
        errors.push(error.message)
      },
    })
    await stream.start()
    await stream.receive(new Uint8Array(bytes as number[]))
    expect(errors.join(' ')).toContain(expected)
    await expect(stream.send('{"method":"ping"}')).rejects.toThrow('closed')
  })

  it('rejects an unknown extension method instead of announcing protocol readiness', async () => {
    const errors: Error[] = []
    const stream = new FramedStream({
      write: async () => {},
      onMessage: async () => {},
      onError: (e) => {
        errors.push(e)
      },
    })
    await stream.start()
    await stream.receive(new Uint8Array([80, 87, 84, 67, 49, 10]))
    await expect(stream.send('{"method":"invented-command"}')).rejects.toThrow('method')
    stream.close()
  })
  it('accepts the inclusive 16 MiB record limit without retaining an extra encoded copy', async () => {
    const stream = new FramedStream({ write: async () => {}, onMessage: async () => {}, onError: () => {} })
    await stream.start()
    await stream.receive(new Uint8Array([80, 87, 84, 67, 49, 10]))
    const json = '{"id":1,"result":"' + 'x'.repeat(16_777_196) + '"}'
    await expect(stream.send(json)).resolves.toBeUndefined()
    stream.close()
  })
})
