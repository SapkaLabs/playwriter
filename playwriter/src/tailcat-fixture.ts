import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

/** Harmless, isolated acceptance fixture. All state and URLs belong to this run. */
export async function startTailcatFixture() {
  const nonce = randomUUID()
  const requests: Record<string, number> = {}
  const html = `<!doctype html><meta charset="utf-8"><title>DERP fixture</title>
<h1>DERP fixture</h1><p id="nonce">${nonce}</p>
<button id="count">Click counter</button><output id="counter">0</output>
<label>Unicode text <input id="text"></label><button id="json">Load JSON</button>
<button id="large">Load oversized JSON</button><button id="evict">Load evicted JSON</button>
<a href="/next">Navigate fixture</a><div style="height:1800px"></div><p id="bottom">Scroll marker</p>
<script>
const history = JSON.parse(sessionStorage.history || '[]');
window.fixtureHistory = history;
function append(event) { history.push(event); sessionStorage.history = JSON.stringify(history) }
document.querySelector('#count').onclick = () => { const node = document.querySelector('#counter'); node.value = String(Number(node.value) + 1); append({type:'click', value:node.value}) };
document.querySelector('#text').oninput = event => append({type:'input', value:event.target.value});
for (const [id, path] of [['json','json'],['large','oversized'],['evict','evicted']]) document.querySelector('#'+id).onclick = () => { fetch('/'+path+'?run=${nonce}').then(r => r.json()).then(() => console.log('fixture JSON '+path)) };
console.log('fixture ready ${nonce}');
</script>`
  const server = createServer((request, response) => {
    const path = new URL(request.url || '/', 'http://fixture').pathname
    requests[path] = (requests[path] || 0) + 1
    if (['/json', '/oversized', '/evicted'].includes(path)) {
      const json = JSON.stringify({
        nonce,
        message: 'Привіт 👋 漢字',
        padding: 'x'.repeat(path === '/oversized' ? 65537 : path === '/evicted' ? 8192 : 16),
      })
      response
        .writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(json),
        })
        .end(json)
    } else
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html)
  })
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', ok)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/fixture`,
    port,
    nonce,
    requests,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  }
}
