import { MAX_CHUNK } from 'playwriter/src/tailcat-tunnel/protocol'

// Exactly one worker per background-owned port. Port loss is revocation, never restoration.
let owner: chrome.runtime.Port | null = null
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'playwriter-tailcat' || port.sender?.id !== chrome.runtime.id) return
  if (owner) {
    port.disconnect()
    return
  }
  owner = port
  const worker = new Worker(new URL('./worker.ts', import.meta.url))
  const dispose = () => {
    worker.terminate()
    if (owner === port) owner = null
    port.disconnect()
  }
  port.onDisconnect.addListener(dispose)
  worker.onerror = () => {
    port.postMessage({ fatal: 'Transport worker lost; sharing revoked' })
    dispose()
  }
  worker.onmessage = ({ data }) => {
    if (data.result instanceof Uint8Array) {
      // Chrome runtime messaging is JSON-only; raw chunks are at most 64 KiB.
      data.result = { base64: btoa(Array.from(data.result as Uint8Array, (b) => String.fromCharCode(b)).join('')) }
    }
    port.postMessage(data)
  }
  port.onMessage.addListener((data) => {
    if (data.action === 'stop') {
      worker.terminate()
      if (owner === port) owner = null
      port.postMessage({ stopped: true })
      port.disconnect()
      return
    }
    if (import.meta.env.TESTING && data.action === 'testKill') {
      port.postMessage({ fatal: 'Transport worker terminated for test; sharing revoked' })
      dispose()
      return
    }
    if (typeof data.base64 === 'string') {
      if (data.base64.length > Math.ceil(MAX_CHUNK / 3) * 4) {
        dispose()
        return
      }
      data.bytes = Uint8Array.from(atob(data.base64), (c) => c.charCodeAt(0))
      delete data.base64
    }
    worker.postMessage(data, data.bytes ? [data.bytes.buffer] : [])
  })
})
