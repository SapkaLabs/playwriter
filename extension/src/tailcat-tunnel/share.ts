export {}
const tabs = document.querySelector<HTMLSelectElement>('#tabs')!
const start = document.querySelector<HTMLButtonElement>('#start')!
const stop = document.querySelector<HTMLButtonElement>('#stop')!
const copy = document.querySelector<HTMLButtonElement>('#copy')!
const descriptor = document.querySelector<HTMLTextAreaElement>('#descriptor')!
const status = document.querySelector<HTMLElement>('[role=status]')!
for (const tab of await chrome.tabs.query({})) {
  if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) continue
  const option = document.createElement('option')
  option.value = String(tab.id)
  option.textContent = tab.title || tab.url
  tabs.append(option)
}
const selected = new URLSearchParams(location.search).get('tab')
if (selected) tabs.value = selected
async function refresh() {
  const state = await chrome.runtime.sendMessage({ action: 'tailcatStatus' })
  status.textContent = state.status + (state.error ? ' — ' + state.error : '')
  descriptor.value = state.descriptor || ''
  start.disabled = state.status !== 'stopped'
  stop.disabled = !state.active
  copy.disabled = state.status === 'starting' || !descriptor.value
}
start.onclick = () => {
  start.disabled = true
  stop.disabled = false
  status.textContent = 'starting'
  void chrome.runtime.sendMessage({ action: 'tailcatStart', tabId: Number(tabs.value) }).then(refresh)
}
stop.onclick = () => {
  void chrome.runtime.sendMessage({ action: 'tailcatStop' }).then(refresh)
}
copy.onclick = () => {
  void chrome.runtime.sendMessage({ action: 'tailcatCopy' })
}
setInterval(() => {
  void refresh()
}, 500)
void refresh()
