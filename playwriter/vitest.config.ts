import { defineConfig } from 'vitest/config'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every invocation gets private recovery/log state. No test relay should inspect
// the user's ordinary daemon's cloud-session recovery file or overwrite its logs.
const stateDirectory = mkdtempSync(join(tmpdir(), 'playwriter-regression-'))

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000, // 60 seconds for Chrome startup
    hookTimeout: 30000,
    exclude: ['dist', 'dist/**/*', 'node_modules/**'],
    setupFiles: ['./vitest.setup.ts'],

    env: {
      PLAYWRITER_NODE_ENV: 'development',
      PLAYWRITER_TELEMETRY: '0',
      PLAYWRITER_STATE_DIRECTORY: stateDirectory,
      PLAYWRITER_LOG_FILE_PATH: join(stateDirectory, 'relay.log'),
      PLAYWRITER_CDP_LOG_FILE_PATH: join(stateDirectory, 'cdp.jsonl'),
    },
  },
})
