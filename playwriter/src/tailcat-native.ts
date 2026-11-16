// Pipe supervisor: IPC loss also kills the owned native child on Windows.
import { spawn } from 'node:child_process'
const child = spawn(
  process.argv[2],
  ['--key=new', '--derpmap-url=https://tailcat.dev/derpmap.json', process.argv[3], '1'],
  {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  },
)
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
  process.send?.({ exited: true })
  process.exit(code ?? 1)
})
const close = () => {
  child.kill()
  setTimeout(() => process.exit(1), 1000).unref()
}
process.on('disconnect', close)
process.on('SIGINT', close)
process.on('SIGTERM', close)
