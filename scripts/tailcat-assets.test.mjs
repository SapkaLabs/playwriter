import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Approved seam 6: exercise the actual provisioning entry point and emitted assets.
test('pinned dependency provisioning emits matching native, WASM and Go runtime with verifiable hashes', () => {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/build-tailcat.mjs',
      '--go',
      resolve('tmp/tailcat-build/go/bin/go.exe'),
      '--cache',
      resolve('tmp/tailcat-build'),
      '--out',
      resolve('tmp/tailcat-assets'),
    ],
    { encoding: 'utf8', timeout: 300_000 },
  )
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(readFileSync('tmp/tailcat-assets/manifest.json', 'utf8'))
  assert.equal(manifest.source.commit, 'e00cdde6ff787f801361ff85ed085775c775d4c5')
  assert.match(manifest.toolchain, /^go version go1\.27\.2 /)
  assert.deepEqual([...readFileSync('tmp/tailcat-assets/main.wasm').subarray(0, 4)], [0, 97, 115, 109])
  assert.deepEqual(
    readFileSync('tmp/tailcat-assets/wasm_exec.js'),
    readFileSync('tmp/tailcat-build/go/lib/wasm/wasm_exec.js'),
  )
  const verification = spawnSync(
    process.execPath,
    ['scripts/build-tailcat.mjs', '--verify', '--out', resolve('tmp/tailcat-assets')],
    { encoding: 'utf8' },
  )
  assert.equal(verification.status, 0, verification.stderr)
  assert.ok(manifest.files.some((f) => f.path === (process.platform === 'win32' ? 'tailcat.exe' : 'tailcat')))
  assert.ok(manifest.files.some((f) => f.path === 'notices/tailcat-LICENSE'))
})
