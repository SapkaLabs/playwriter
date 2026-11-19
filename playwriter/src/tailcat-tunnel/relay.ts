// Dedicated relay process; it never consumes personal daemon/cloud state.
import { startPlayWriterCDPRelayServer } from '../cdp-relay.js'
import { join } from 'node:path'
const relay = await startPlayWriterCDPRelayServer({
  host: '127.0.0.1',
  port: Number(process.argv[2]),
  stateDirectory: process.argv[3],
  sessionCounterFile: join(process.argv[3], 'session-counter'),
  allowLocalExtensions: false,
  cdpLogger: { log: () => {}, flush: async () => {}, logFilePath: '' },
  logger: { log: () => {}, error: () => {} },
  onExecuteFailure: () => {
    process.send?.({ executeFailed: true })
  },
  extensionTimeouts: { command: 30_000, awaitPromise: 30_000 },
})
process.send?.({ ready: true })
const close = () => {
  relay.close()
  process.exit(0)
}
process.on('disconnect', close)
process.on('SIGINT', close)
process.on('SIGTERM', close)
