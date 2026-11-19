import {
  isRoute,
  parseConnectionCopyReply,
  parseConnectionStatusReply,
  routeName,
  sameServer,
  serverName,
  type ConnectionReply,
  type ConnectionRequest,
  type ConnectionTarget,
  type LocalConnection,
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

const labels = {
  disconnected: 'Disconnected',
  connecting: 'Connecting to Local…',
  connected: 'Connected to Local',
  reconnecting: 'Reconnecting to Local…',
  disconnecting: 'Disconnecting from Local…',
} satisfies Record<LocalConnection['kind'], string>
let serverOptionsKey = ''
let pendingTarget: ConnectionTarget | undefined
let pendingName = 'Local'
let activeName = 'Local'
let confirmedTarget: ConnectionTarget | undefined
let requestError = ''

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text
}

function render(reply: Extract<ConnectionReply, { kind: 'status' }>): void {
  const { connection, preferences } = reply
  const { route, tailcatServerId } = preferences.pending
  const selected = preferences.servers.find((item) =>
    item.kind === 'public' ? tailcatServerId === null : item.id === tailcatServerId,
  )
  pendingName = routeName(route, selected)
  pendingTarget = route === 'tailcat' ? selected && { route, server: selected } : { route }
  const activeRoute = connection.kind === 'remote' ? connection.route : 'local'
  activeName = routeName(activeRoute, 'server' in connection ? connection.server : undefined)
  const busy =
    connection.kind === 'transition' || connection.kind === 'connecting' || connection.kind === 'disconnecting'
  const browserScope = 'scope' in connection && connection.scope === 'browser'
  const sameTarget =
    browserScope &&
    activeRoute === route &&
    (route !== 'tailcat' || (selected && 'server' in connection && sameServer(selected, connection.server)))
  if (connection.kind === 'transition') {
    showProgress(connection.phase, connection.name)
  } else if (connection.kind === 'remote') {
    status.dataset.state = connection.online
      ? 'connected'
      : connection.scope === 'browser'
        ? 'reconnecting'
        : 'connecting'
    const action = connection.online ? 'Connected' : connection.scope === 'browser' ? 'Reconnecting' : 'Connecting'
    setText(state, `${action} to ${activeName}${connection.online ? '' : '…'}`)
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
    !pendingTarget
      ? 'The saved Tailcat server is unavailable. Choose another server or open Manage Servers.'
      : connection.kind !== 'disconnected' && !sameTarget
        ? 'Connect replaces the current connection.'
        : '',
  )
  setText(error, requestError || reply.error)
  disconnect.hidden = connection.kind === 'disconnected' || connection.kind === 'connecting'
  disconnect.disabled = busy
  copyConnection.hidden = connection.kind !== 'remote' || !browserScope || !connection.online
  setText(copyConnection, activeRoute === 'tailcat' ? 'Copy connection information' : 'Copy CLI command')
  if (copyConnection.hidden) setText(copyState, '')
  routes.disabled = busy
  connect.disabled = busy || !pendingTarget || Boolean(sameTarget)
  for (const input of routeInputs) input.checked = input.value === route
  serverChoice.hidden = route !== 'tailcat'
  const optionsKey = JSON.stringify([preferences.servers, selected ? null : tailcatServerId])
  if (optionsKey !== serverOptionsKey) {
    server.replaceChildren(
      ...preferences.servers.map((item) => new Option(serverName(item), item.kind === 'public' ? '' : item.id)),
    )
    if (!selected && tailcatServerId) {
      const unavailable = new Option('Unavailable saved server', tailcatServerId)
      unavailable.disabled = true
      server.add(unavailable)
    }
    serverOptionsKey = optionsKey
  }
  server.value = tailcatServerId ?? ''
}

function showProgress(phase: 'connecting' | 'disconnecting', name: string): void {
  status.dataset.state = phase
  setText(state, `${phase === 'connecting' ? 'Connecting to' : 'Disconnecting from'} ${name}…`)
}

let changePending = false
let revision = 0

async function request(request: ConnectionRequest): Promise<void> {
  const current = ++revision
  try {
    const reply = parseConnectionStatusReply(
      await chrome.runtime.sendMessage({ action: 'connectionSettings', request }),
    )
    if (current !== revision) return
    if (reply.kind === 'error') {
      requestError = reply.message
      setText(error, requestError)
    } else if (reply.kind === 'status') render(reply)
  } catch {
    if (current === revision) setText(error, 'Could not load Connection settings. Try again.')
  }
}

async function change(action: Exclude<ConnectionRequest, { kind: 'status' }>): Promise<void> {
  if (changePending) return
  changePending = true
  requestError = ''
  try {
    connect.disabled = true
    routes.disabled = true
    disconnect.disabled = true
    if (action.kind === 'connect' || action.kind === 'disconnect') {
      showProgress(
        action.kind === 'connect' ? 'connecting' : 'disconnecting',
        action.kind === 'connect' ? pendingName : activeName,
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
  const target = pendingTarget
  if (!target) return
  if (target.route !== 'local') {
    confirmedTarget = target
    const credential = target.route === 'tailcat' ? 'private connection information' : 'private CLI command'
    setText(shareTitle, `Share browser through ${pendingName}`)
    setText(
      shareDescription,
      `Anyone with the ${credential} can control eligible tabs in this Chrome profile and open new tabs. Sharing continues until you disconnect or close the browser.`,
    )
    confirmation.returnValue = ''
    confirmation.showModal()
  } else {
    void change({ kind: 'connect', target })
  }
}
confirmation.onclose = () => {
  const target = confirmedTarget
  confirmedTarget = undefined
  if (confirmation.returnValue === 'share' && target) void change({ kind: 'connect', target })
}
disconnect.onclick = () => void change({ kind: 'disconnect' })
copyConnection.onclick = async () => {
  if (changePending) return
  try {
    const reply = parseConnectionCopyReply(
      await chrome.runtime.sendMessage({
        action: 'connectionSettings',
        request: { kind: 'copy-connection' } satisfies ConnectionRequest,
      }),
    )
    if (reply.kind === 'descriptor') {
      await navigator.clipboard.writeText(reply.descriptor)
      setText(copyState, 'Copied connection information')
    } else {
      await navigator.clipboard.writeText(reply.command)
      setText(copyState, 'Copied command')
    }
  } catch {
    setText(copyState, 'Could not copy connection information.')
  }
}

void request({ kind: 'status' })
setInterval(() => {
  if (!document.hidden && !changePending) void request({ kind: 'status' })
}, 1000)
