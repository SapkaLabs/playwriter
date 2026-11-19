import { parseServerReply, serverName, type ServerDirectory, type ServerRequest } from './connection-settings'

function element<T extends Element>(selector: string, type: { new (): T }): T {
  const match = document.querySelector(selector)
  if (!(match instanceof type)) throw new Error(`Missing settings element: ${selector}`)
  return match
}

const list = element('.server-list', HTMLUListElement)
const builtIn = element('.server-list li', HTMLLIElement)
const add = element('#add-server', HTMLButtonElement)
const form = element('#server-form', HTMLFormElement)
const formFields = element('#server-form fieldset', HTMLFieldSetElement)
const formTitle = element('#form-title', HTMLElement)
const name = element('#name', HTMLInputElement)
const url = element('#map-url', HTMLInputElement)
const cancelEdit = element('#cancel-edit', HTMLButtonElement)
const dialog = element('dialog', HTMLDialogElement)
const removeTitle = element('#remove-title', HTMLElement)
const validation = element('#validation', HTMLElement)
const error = element('#error', HTMLElement)

type SavedServer = ServerDirectory['custom'][number]
type Edit = Extract<ServerRequest, { kind: 'add' | 'edit' }>
type Remove = Extract<ServerRequest, { kind: 'remove' }>

let directory: ServerDirectory | undefined
let draft: Edit | undefined
let pendingRemoval: Remove | undefined

function action(label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.onclick = run
  return button
}

function render(next: ServerDirectory): void {
  directory = next
  const rows = next.custom.map((profile) => {
    const server = { kind: 'custom', id: profile.id, revision: profile.revision } satisfies Remove['server']
    const label = serverName({ ...server, name: profile.name })
    const row = document.createElement('li')
    const title = document.createElement('strong')
    title.textContent = label
    const actions = document.createElement('div')
    actions.className = 'server-actions'
    actions.append(
      action('Validate', () => void send({ kind: 'validate', server })),
      action('Edit', () => edit(profile)),
      action('Remove', () => {
        pendingRemoval = { kind: 'remove', server, expectedRevision: next.revision }
        removeTitle.textContent = `Remove ${label}?`
        dialog.returnValue = ''
        dialog.showModal()
      }),
    )
    row.append(title, actions)
    return row
  })
  list.replaceChildren(builtIn, ...rows)
}

function setBusy(busy: boolean): void {
  add.disabled = busy || !directory
  formFields.disabled = busy
  for (const button of list.querySelectorAll('button')) button.disabled = busy
}

async function send(request: ServerRequest): Promise<void> {
  setBusy(true)
  error.textContent = ''
  validation.textContent = request.kind === 'validate' ? 'Validating server…' : ''
  try {
    const reply = parseServerReply(
      await chrome.runtime.sendMessage({ action: 'manageTailcatServers', request }),
      request.kind,
    )
    switch (reply.kind) {
      case 'directory':
        render(reply.directory)
        if (request.kind === 'add' || request.kind === 'edit') {
          form.hidden = true
          draft = undefined
        }
        break
      case 'validated':
        validation.textContent = `Map validated. ${reply.regions} ${reply.regions === 1 ? 'region' : 'regions'} available.`
        break
      case 'error':
        validation.textContent = ''
        error.textContent = reply.message
        break
    }
  } catch {
    validation.textContent = ''
    error.textContent = 'Could not load server settings. Reload the page and try again.'
  } finally {
    setBusy(false)
  }
}

function edit(profile?: SavedServer): void {
  if (!directory) return
  const values = {
    expectedRevision: directory.revision,
    name: profile?.name ?? '',
    derpMapURL: profile?.derpMapURL ?? '',
  }
  draft = profile
    ? { kind: 'edit', server: { kind: 'custom', id: profile.id, revision: profile.revision }, ...values }
    : { kind: 'add', ...values }
  formTitle.textContent = profile ? 'Edit server' : 'Add server'
  name.value = values.name
  url.value = values.derpMapURL
  error.textContent = ''
  validation.textContent = ''
  form.hidden = false
  name.focus()
}

add.onclick = () => edit()
cancelEdit.onclick = () => {
  form.hidden = true
  draft = undefined
}
form.onsubmit = (event) => {
  event.preventDefault()
  if (!draft) return
  void send({ ...draft, name: name.value, derpMapURL: url.value.trim() })
}
dialog.onclose = () => {
  const request = pendingRemoval
  pendingRemoval = undefined
  if (dialog.returnValue === 'remove' && request) void send(request)
}

void send({ kind: 'list' })
