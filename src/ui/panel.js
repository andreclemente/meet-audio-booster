import { PANEL_ID } from '../shared/constants.js'
import { panelStyles, headerStyles } from './styles.js'
import { makeButton, renderParticipantRow } from './participant-row.js'

export function createPanelController(state, { participants, onGain, onSave }) {
  function updateLiveUi() {
    if (!state.panel?.isConnected) return
    for (const participant of participants()) {
      const row = [...state.panel.querySelectorAll('[data-participant-key]')].find(item => item.dataset.participantKey === participant.key)
      if (!row) continue
      const active = participant.platform === 'google-meet'
        ? state.google.activeParticipantKey === participant.key
        : participant.originalTrack?.readyState === 'live'
      const badge = row.querySelector('[data-role="badge"]')
      if (badge) { badge.style.background = active ? '#8ab4f8' : '#5f6368'; badge.title = active ? 'Active audio' : 'Inactive' }
      const value = row.querySelector('[data-role="value"]')
      if (value) value.textContent = `${Math.round(participant.value * 100)}%`
      const slider = row.querySelector('[data-role="slider"]')
      if (slider && document.activeElement !== slider) slider.value = String(participant.value)
    }
  }
  function render() {
    if (state.closed || !document.documentElement) return
    const listItems = participants()
    let panel = document.getElementById(PANEL_ID)
    if (!panel) { panel = document.createElement('div'); panel.id = PANEL_ID; document.documentElement.append(panel) }
    panel.replaceChildren()
    panel.style.display = 'block'
    Object.assign(panel.style, panelStyles)
    if (state.settings.position) Object.assign(panel.style, { left: `${state.settings.position.left}px`, top: `${state.settings.position.top}px`, right: 'auto' })
    else Object.assign(panel.style, { right: '12px', top: '72px', left: 'auto' })
    const header = document.createElement('div')
    Object.assign(header.style, headerStyles)
    const titleWrap = document.createElement('div')
    titleWrap.style.minWidth = '0'
    const title = document.createElement('div')
    title.textContent = state.platform === 'google-meet' ? 'Google Meet Audio Booster' : 'Jitsi Audio Booster'
    Object.assign(title.style, { fontWeight: '700', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
    const subtitle = document.createElement('div')
    const outputCount = state.google.mode === 'media' ? state.google.mediaPipelines.length : state.google.slots.length
    subtitle.textContent = state.platform === 'google-meet'
      ? `${listItems.length} participant${listItems.length === 1 ? '' : 's'} · ${outputCount} ${state.google.mode === 'media' ? 'media stream' : 'audio slot'}${outputCount === 1 ? '' : 's'}`
      : `${listItems.length} remote audio track${listItems.length === 1 ? '' : 's'}`
    Object.assign(subtitle.style, { opacity: '0.68', fontSize: '11px', marginTop: '2px' })
    titleWrap.append(title, subtitle)
    const close = makeButton('×', hide)
    Object.assign(close.style, { width: '26px', height: '26px', padding: '0', fontSize: '16px', lineHeight: '16px', flex: '0 0 auto' })
    header.append(titleWrap, close)
    panel.append(header)
    makeDraggable(panel, header, onSave)
    const list = document.createElement('div')
    Object.assign(list.style, { maxHeight: '310px', overflowY: 'auto', paddingRight: '4px' })
    if (!listItems.length) {
      const empty = document.createElement('div'); empty.textContent = 'Waiting for remote participants…'
      Object.assign(empty.style, { opacity: '0.75', padding: '8px 0' }); list.append(empty)
    }
    for (const participant of listItems) list.append(renderParticipantRow(participant, onGain))
    panel.append(list)
    const footer = document.createElement('div')
    Object.assign(footer.style, { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '6px', marginTop: '9px', paddingTop: '8px', borderTop: '1px solid #3c4043' })
    footer.append(makeButton('Reset all', () => { for (const participant of listItems) onGain(participant, 1); render() }))
    panel.append(footer)
    const status = document.createElement('div')
    status.id = `${PANEL_ID}_status`; status.textContent = state.status
    Object.assign(status.style, { minHeight: '14px', marginTop: '7px', color: '#bdc1c6', fontSize: '11px', lineHeight: '14px' })
    panel.append(status)
    state.panel = panel
    updateLiveUi()
  }
  function show() { state.closed = false; render(); if (state.panel) state.panel.style.display = 'block' }
  function hide() { state.closed = true; if (state.panel) state.panel.style.display = 'none' }
  function toggle() { state.closed ? show() : hide() }
  return { render, show, hide, toggle, updateLiveUi }
}

function makeDraggable(panel, handle, onSave) {
  handle.style.cursor = 'move'
  handle.onmousedown = event => {
    if (event.target.closest('button, input, textarea, select')) return
    const rect = panel.getBoundingClientRect()
    panel.__boosterDrag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
    event.preventDefault()
  }
  if (panel.__boosterDragInstalled) return
  panel.__boosterDragInstalled = true
  globalThis.addEventListener('mousemove', event => {
    const start = panel.__boosterDrag
    if (!start) return
    panel.style.left = `${Math.max(8, start.left + event.clientX - start.x)}px`
    panel.style.top = `${Math.max(8, start.top + event.clientY - start.y)}px`
    panel.style.right = 'auto'
  })
  globalThis.addEventListener('mouseup', () => {
    if (!panel.__boosterDrag) return
    panel.__boosterDrag = null
    const rect = panel.getBoundingClientRect()
    onSave({ left: rect.left, top: rect.top })
  })
}
