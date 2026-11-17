import { ProfileStore, type Profiles, type ProfileMutation } from 'playwriter/src/tailcat-tunnel/config'
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const tabs = element<HTMLSelectElement>('tabs'),
  servers = element<HTMLSelectElement>('server'),
  manager = element<HTMLSelectElement>('manage-server')
const start = element<HTMLButtonElement>('start'),
  stop = element<HTMLButtonElement>('stop'),
  copy = element<HTMLButtonElement>('copy')
const descriptor = element<HTMLTextAreaElement>('descriptor'),
  status = document.querySelector<HTMLElement>('[role=status]')!,
  error = element<HTMLElement>('error')
const form = element<HTMLFormElement>('profile-form'),
  name = element<HTMLInputElement>('profile-name'),
  url = element<HTMLInputElement>('profile-url')
let profiles: Profiles | undefined
let active = false,
  activeProfile: string | undefined,
  updating = false
let editId: string | undefined,
  editRevision = 0
async function send(action: string, data: object = {}) {
  const result = await chrome.runtime.sendMessage({ action, ...data })
  // Status errors describe the current failed share, not a failed status query.
  if (result?.error && action !== 'tailcatStatus') throw new Error(result.error)
  return result
}
function report(reason: unknown) {
  error.textContent = reason instanceof Error ? reason.message : 'Operation failed'
}
for (const tab of await chrome.tabs.query({})) {
  if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) continue
  tabs.add(new Option(tab.title || tab.url, String(tab.id)))
}
const selected = new URLSearchParams(location.search).get('tab')
if (selected) tabs.value = selected
function displayProfiles(next: Profiles) {
  if (profiles?.revision !== next.revision) {
    const managed = manager.value
    servers.replaceChildren(new Option('Select a server', ''))
    manager.replaceChildren()
    for (const p of next.profiles) {
      servers.add(new Option(p.name, p.id))
      manager.add(new Option(p.name, p.id))
    }
    manager.value = next.profiles.some((p) => p.id === managed)
      ? managed
      : (next.selectedProfileId ?? next.profiles[0]?.id ?? '')
  }
  profiles = next
  servers.value = next.selectedProfileId ?? ''
  element('server-url').textContent =
    next.profiles.find((p) => p.id === next.selectedProfileId)?.derpMapURL ?? 'No server selected'
}
async function refresh() {
  const state = await send('tailcatStatus')
  active = state.active
  activeProfile = state.profileId
  status.textContent = state.status + (state.error ? ' — ' + state.error : '')
  descriptor.value = state.descriptor || ''
  copy.disabled = state.status === 'starting' || !descriptor.value
  try {
    displayProfiles((await send('tailcatProfiles')).profiles)
  } catch (e) {
    profiles = undefined
    report(e)
  }
  start.disabled =
    updating || !profiles?.selectedProfileId || !tabs.value || !['stopped', 'failed'].includes(state.status)
  servers.disabled = updating || state.status === 'stopping'
  for (const id of ['add', 'edit', 'remove', 'validate'])
    element<HTMLButtonElement>(id).disabled = updating || !profiles || (id !== 'add' && !manager.value)
  // Stop is deliberately never disabled by connectivity, startup or failure.
  stop.disabled = false
}
async function confirmChange(message: string, action: string): Promise<boolean> {
  const panel = element('confirm-change')
  element('confirm-text').textContent = message
  element('confirm-action').textContent = action
  panel.hidden = false
  return new Promise((resolve) => {
    const finish = (accepted: boolean) => {
      panel.hidden = true
      resolve(accepted)
    }
    element('confirm-action').onclick = () => finish(true)
    element('confirm-cancel').onclick = () => finish(false)
    element('confirm-cancel').focus()
  })
}
async function update(change: ProfileMutation, prompt?: string, action = 'Stop and select') {
  if (!profiles || updating) return
  // Reject malformed input before offering to revoke a healthy share.
  await new ProfileStore({ read: async () => profiles, write: async () => {} }).update(change)
  const stopActive = !!prompt && active
  updating = true
  try {
    if (stopActive && !(await confirmChange(prompt!, action))) return
    displayProfiles((await send('tailcatProfileUpdate', { change, stopActive })).profiles)
    error.textContent = ''
    form.hidden = true
  } finally {
    updating = false
    await refresh()
  }
}
servers.onchange = () => {
  if (!profiles) return
  const id = servers.value || null
  void update(
    { action: 'select', id, expectedRevision: profiles.revision },
    `Stop sharing and select ${profiles.profiles.find((p) => p.id === id)?.name ?? 'no server'}?`,
  ).catch(report)
}
element('add').onclick = () => {
  if (!profiles) return
  editId = undefined
  editRevision = profiles.revision
  name.value = ''
  url.value = ''
  form.hidden = false
  name.focus()
}
element('edit').onclick = () => {
  const p = profiles?.profiles.find((p) => p.id === manager.value)
  if (!p || !profiles) return
  editId = p.id
  editRevision = profiles.revision
  name.value = p.name
  url.value = p.derpMapURL
  form.hidden = false
}
element('cancel-edit').onclick = () => {
  form.hidden = true
}
form.onsubmit = (event) => {
  event.preventDefault()
  void update(
    {
      action: editId ? 'edit' : 'add',
      id: editId,
      name: name.value,
      derpMapURL: url.value,
      expectedRevision: editRevision,
    },
    editId === activeProfile ? 'Stop sharing and save this server?' : undefined,
    'Stop and save',
  ).catch(report)
}
element('remove').onclick = () => {
  if (!profiles || !manager.value) return
  const id = manager.value
  if (!(active && id === activeProfile) && !confirm('Remove this server?')) return
  void update(
    { action: 'remove', id, expectedRevision: profiles.revision },
    id === activeProfile ? 'Stop sharing and remove this server?' : undefined,
    'Stop and remove',
  ).catch(report)
}
element('validate').onclick = () => {
  element('validation').textContent = 'Validating selected map…'
  void send('tailcatValidate', { profileId: manager.value }).then(
    (result) => {
      element('validation').textContent = result.regions
        .map((r: { id: number; nodes: string[] }) => `Region ${r.id}: ${r.nodes.join(', ')}`)
        .join('\n')
      error.textContent = ''
    },
    (e) => {
      element('validation').textContent = ''
      report(e)
    },
  )
}
start.onclick = () => {
  start.disabled = true
  status.textContent = 'starting'
  error.textContent = ''
  void send('tailcatStart', { tabId: Number(tabs.value) })
    .then(refresh)
    .catch(report)
}
stop.onclick = () => {
  void send('tailcatStop').then(refresh).catch(report)
}
copy.onclick = () => {
  void send('tailcatCopy').catch(report)
}
setInterval(() => {
  void refresh().catch(report)
}, 500)
void refresh().catch(report)
