import { describe, expect, it } from 'vitest'
import { FramedStream } from './tailcat-protocol.js'

describe('public Tailcat framed byte stream', () => {
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
})
