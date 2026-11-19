import {
  isRoute,
  type ConnectionReply,
  type ConnectionRequest,
  type LocalConnection,
  type RemoteRoute,
  type Route,
} from './connection-settings'

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
const copyConnection = element('#copy-connection', HTMLButtonElement)
const copyState = element('#copy-state', HTMLElement)
const confirmation = element('dialog', HTMLDialogElement)
const shareTitle = element('#share-title', HTMLElement)
const shareDescription = element('#share-description', HTMLElement)
const routeInputs = Array.from(routes.querySelectorAll('input'))
const routeNames = { local: 'Local', hosted: 'playwriter.dev', tailcat: 'Public Tailcat' } satisfies Record<
  Route,
  string
>

const labels = {
  disconnected: 'Disconnected',
  connecting: 'Connecting to Local…',
  connected: 'Connected to Local',
  reconnecting: 'Reconnecting to Local…',
  disconnecting: 'Disconnecting from Local…',
} satisfies Record<LocalConnection['kind'], string>
let serverOptionsKey = ''
let selectedRoute: Route = 'local'
let activeRoute: Route = 'local'
let confirmingRoute: RemoteRoute | undefined

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text
}

function render(reply: Extract<ConnectionReply, { kind: 'status' }>): void {
  const { connection, preferences } = reply
  const { route, tailcatServerId } = preferences.pending
  selectedRoute = route
  activeRoute = 'route' in connection ? connection.route : 'local'
  const busy =
    connection.kind === 'transition' || connection.kind === 'connecting' || connection.kind === 'disconnecting'
  const browserScope = 'scope' in connection && connection.scope === 'browser'
  if (connection.kind === 'transition') {
    showProgress(connection.phase, connection.route)
  } else if (connection.kind === 'remote') {
    status.dataset.state = connection.online
      ? 'connected'
      : connection.scope === 'browser'
        ? 'reconnecting'
        : 'connecting'
    const name = connection.route === 'tailcat' && connection.scope === 'tab' ? 'Tailcat' : routeNames[connection.route]
    const action = connection.online ? 'Connected' : connection.scope === 'browser' ? 'Reconnecting' : 'Connecting'
    setText(state, `${action} to ${name}${connection.online ? '' : '…'}`)
  } else if (connection.kind === 'connected' && connection.scope === 'tab') {
    status.dataset.state = connection.kind
    setText(state, 'Connected to Local (per tab)')
  } else {
    status.dataset.state = connection.kind
    setText(state, labels[connection.kind])
  }
  setText(
    detail,
    'tabs' in connection
      ? connection.tabs
        ? `${connection.tabs} attached ${connection.tabs === 1 ? 'tab' : 'tabs'}`
        : 'No eligible tabs'
      : '',
  )
  setText(
    pending,
    route === 'tailcat' && tailcatServerId !== null
      ? 'Custom Tailcat servers are unavailable in Connection settings.'
      : connection.kind !== 'disconnected' && activeRoute !== route
        ? 'Connect replaces the current connection.'
        : '',
  )
  setText(error, reply.error)
  disconnect.hidden = connection.kind === 'disconnected' || connection.kind === 'connecting'
  disconnect.disabled = busy
  copyConnection.hidden = connection.kind !== 'remote' || !browserScope || !connection.online
  setText(copyConnection, activeRoute === 'tailcat' ? 'Copy connection information' : 'Copy CLI command')
  if (copyConnection.hidden) setText(copyState, '')
  routes.disabled = busy
  connect.disabled =
    busy || (route === 'tailcat' && tailcatServerId !== null) || (browserScope && activeRoute === route)
  for (const input of routeInputs) input.checked = input.value === route
  serverChoice.hidden = route !== 'tailcat'
  const optionsKey = JSON.stringify(preferences.servers)
  if (optionsKey !== serverOptionsKey) {
    server.replaceChildren(...preferences.servers.map(({ id, name }) => new Option(name, id ?? '')))
    serverOptionsKey = optionsKey
  }
  server.value = tailcatServerId ?? ''
}

function showProgress(phase: 'connecting' | 'disconnecting', route: Route): void {
  status.dataset.state = phase
  setText(state, `${phase === 'connecting' ? 'Connecting to' : 'Disconnecting from'} ${routeNames[route]}…`)
}

let changePending = false
let revision = 0

async function request(request: ConnectionRequest): Promise<void> {
  const current = ++revision
  try {
    const reply: ConnectionReply = await chrome.runtime.sendMessage({ action: 'connectionSettings', request })
    if (current !== revision) return
    if (reply.kind === 'error') setText(error, reply.message)
    else if (reply.kind === 'status') render(reply)
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
      showProgress(
        action.kind === 'connect' ? 'connecting' : 'disconnecting',
        action.kind === 'connect' ? selectedRoute : activeRoute,
      )
      copyConnection.hidden = true
      setText(copyState, '')
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
connect.onclick = () => {
  if (selectedRoute !== 'local') {
    confirmingRoute = selectedRoute
    const credential = selectedRoute === 'tailcat' ? 'private connection information' : 'private CLI command'
    setText(shareTitle, `Share browser through ${routeNames[selectedRoute]}`)
    setText(
      shareDescription,
      `Anyone with the ${credential} can control eligible tabs in this Chrome profile and open new tabs. Sharing continues until you disconnect or close the browser.`,
    )
    confirmation.returnValue = ''
    confirmation.showModal()
  } else {
    void change({ kind: 'connect' })
  }
}
confirmation.onclose = () => {
  const confirmedRoute = confirmingRoute
  confirmingRoute = undefined
  if (confirmation.returnValue === 'share' && confirmedRoute) void change({ kind: 'connect', confirmedRoute })
}
disconnect.onclick = () => void change({ kind: 'disconnect' })
copyConnection.onclick = async () => {
  if (changePending) return
  try {
    const reply: ConnectionReply = await chrome.runtime.sendMessage({
      action: 'connectionSettings',
      request: { kind: 'copy-connection' } satisfies ConnectionRequest,
    })
    if (reply.kind === 'descriptor') {
      await navigator.clipboard.writeText(reply.descriptor)
      setText(copyState, 'Copied connection information')
    } else if (reply.kind === 'command') {
      await navigator.clipboard.writeText(reply.command)
      setText(copyState, 'Copied command')
    } else {
      throw new Error('Connection information unavailable')
    }
  } catch {
    setText(copyState, 'Could not copy connection information.')
  }
}

void request({ kind: 'status' })
setInterval(() => {
  if (!document.hidden && !changePending) void request({ kind: 'status' })
}, 1000)
