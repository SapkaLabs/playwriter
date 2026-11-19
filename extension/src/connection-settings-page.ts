import { isRoute, type ConnectionReply, type ConnectionRequest, type LocalConnection } from './connection-settings'

function element<T extends Element>(selector: string, type: { new (): T }): T {
  const match = document.querySelector(selector)
  if (!(match instanceof type)) throw new Error(`Missing settings element: ${selector}`)
  return match
}

const status = element('.status', HTMLElement)
const state = element('#state', HTMLElement)
const detail = element('#detail', HTMLElement)
const routes = element('fieldset', HTMLFieldSetElement)
const serverChoice = element('#server-choice', HTMLLabelElement)
const server = element('#server', HTMLSelectElement)
const pending = element('#pending', HTMLElement)
const error = element('#error', HTMLElement)
const connect = element('#connect', HTMLButtonElement)
const disconnect = element('#disconnect', HTMLButtonElement)
const routeInputs = Array.from(routes.querySelectorAll('input'))

const labels = {
  disconnected: 'Disconnected',
  connecting: 'Connecting to Local…',
  connected: 'Connected to Local',
  reconnecting: 'Reconnecting to Local…',
  disconnecting: 'Disconnecting from Local…',
} satisfies Record<LocalConnection['kind'], string>
let serverOptionsKey = ''

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text
}

function render(reply: Extract<ConnectionReply, { kind: 'status' }>): void {
  const { connection, preferences } = reply
  const { route, tailcatServerId } = preferences.pending
  const busy = connection.kind === 'connecting' || connection.kind === 'disconnecting'
  status.dataset.state =
    connection.kind === 'remote' ? (connection.online ? 'connected' : 'connecting') : connection.kind
  if (connection.kind === 'remote') {
    const name = connection.route === 'hosted' ? 'playwriter.dev' : 'Tailcat'
    setText(state, connection.online ? `Connected to ${name}` : `Connecting to ${name}…`)
  } else if (connection.kind === 'connected' && connection.scope === 'tab') {
    setText(state, 'Connected to Local (per tab)')
  } else {
    setText(state, labels[connection.kind])
  }
  setText(
    detail,
    connection.kind === 'connected'
      ? connection.tabs
        ? `${connection.tabs} attached ${connection.tabs === 1 ? 'tab' : 'tabs'}`
        : 'No eligible tabs'
      : '',
  )
  setText(
    pending,
    route !== 'local'
      ? 'The selected route is unavailable in Connection settings.'
      : connection.kind === 'remote'
        ? 'Connect replaces the current connection.'
        : '',
  )
  setText(error, reply.error)
  disconnect.hidden = connection.kind === 'disconnected' || connection.kind === 'connecting'
  disconnect.disabled = busy
  routes.disabled = busy
  connect.disabled = busy || route !== 'local' || (connection.kind === 'connected' && connection.scope === 'browser')
  for (const input of routeInputs) input.checked = input.value === route
  serverChoice.hidden = route !== 'tailcat'
  const optionsKey = JSON.stringify(preferences.servers)
  if (optionsKey !== serverOptionsKey) {
    server.replaceChildren(...preferences.servers.map(({ id, name }) => new Option(name, id ?? '')))
    serverOptionsKey = optionsKey
  }
  server.value = tailcatServerId ?? ''
}

let changePending = false
let revision = 0

async function request(request: ConnectionRequest): Promise<void> {
  const current = ++revision
  try {
    const reply: ConnectionReply = await chrome.runtime.sendMessage({ action: 'connectionSettings', request })
    if (current !== revision) return
    if (reply.kind === 'error') setText(error, reply.message)
    else render(reply)
  } catch {
    if (current === revision) setText(error, 'Could not load Connection settings. Try again.')
  }
}

async function change(action: Exclude<ConnectionRequest, { kind: 'status' }>): Promise<void> {
  if (changePending) return
  changePending = true
  try {
    connect.disabled = true
    routes.disabled = true
    disconnect.disabled = true
    if (action.kind === 'connect' || action.kind === 'disconnect') {
      const progress = action.kind === 'connect' ? 'connecting' : 'disconnecting'
      status.dataset.state = progress
      setText(state, labels[progress])
      setText(detail, '')
      setText(error, '')
    }
    await request(action)
  } finally {
    changePending = false
  }
}

for (const input of routeInputs) {
  input.onchange = () => {
    if (input.checked && isRoute(input.value)) void change({ kind: 'select', route: input.value })
  }
}
server.onchange = () => void change({ kind: 'select-server', id: server.value || null })
connect.onclick = () => void change({ kind: 'connect' })
disconnect.onclick = () => void change({ kind: 'disconnect' })

void request({ kind: 'status' })
setInterval(() => {
  if (!document.hidden && !changePending) void request({ kind: 'status' })
}, 1000)
