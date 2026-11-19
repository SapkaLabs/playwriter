// Pipe supervisor: IPC loss also kills the owned native child on Windows.
import { spawn } from 'node:child_process'
const child = spawn(process.argv[2], ['--config', process.argv[3]], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
})
let control = ''
let established = false
child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
  control += chunk
  const newline = control.indexOf('\n')
  if (control.length > 256 || (newline >= 0 && (established || control !== '{"stage":"stream-established"}\n'))) {
    child.kill()
    return
  }
  if (newline >= 0) {
    established = true
    control = ''
    if (process.connected) process.send?.({ stage: 'stream-established' }, () => {})
  }
})
process.stdin.pipe(child.stdin)
if (process.env.PLAYWRITER_TAILCAT_TESTS === '1')
  child.stdout.on('data', (bytes: Buffer) => {
    if (process.connected) process.send?.({ pipeReadBytes: bytes.length }, () => {})
  })
child.stdout.pipe(process.stdout)
child.on('spawn', () => process.send?.({ nativePid: child.pid }))
child.on('error', () => {
  process.send?.({ error: 'Native process failed to start' })
  process.exit(1)
})
child.on('exit', (code) => {
  if (process.connected) process.send?.({ exited: true })
  process.exit(code ?? 1)
})
const close = () => {
  // EOF lets the owned launcher send TCP FIN so the browser can release its
  // controller slot. Local authority is already revoked; bound cleanup even
  // when the remote route is offline.
  process.stdin.unpipe(child.stdin)
  child.stdin.end()
  setTimeout(() => {
    child.kill()
    process.exit(1)
  }, 1500).unref()
}
process.on('disconnect', close)
process.on('SIGINT', close)
process.on('SIGTERM', close)
