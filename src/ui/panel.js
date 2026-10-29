import { PANEL_ID } from '../shared/constants.js'
import { panelStyles, headerStyles } from './styles.js'
import { makeButton, renderParticipantRow } from './participant-row.js'

export function createPanelController(state, { participants, onGain, onSave, onCollapse }) {
  function updateLiveUi() {
    if (!state.panel?.isConnected) return
    for (const participant of participants()) {
      const row = [...state.panel.querySelectorAll('[data-participant-key]')].find(item => item.dataset.participantKey === participant.key)
      if (!row) continue
      const active = state.google.activeParticipantKey === participant.key
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
    const focused = document.activeElement
    const focusedInside = [...panel.querySelectorAll('button, input, a')].includes(focused)
    const focusedRow = focusedInside ? focused.closest?.('[data-participant-key]') : null
    const focusKey = focusedRow?.dataset.participantKey
    const focusIndex = focusedRow ? [...focusedRow.querySelectorAll('button, input')].indexOf(focused) : -1
    const focusLabel = focusedInside ? focused.getAttribute('aria-label') || focused.textContent : null
    panel.replaceChildren()
    panel.style.display = 'block'
    Object.assign(panel.style, panelStyles)
    if (state.settings.position) Object.assign(panel.style, { left: `${state.settings.position.left}px`, top: `${state.settings.position.top}px`, right: 'auto' })
    else Object.assign(panel.style, { right: '12px', top: '72px', left: 'auto' })
    const header = document.createElement('div')
    Object.assign(header.style, headerStyles)
    const titleWrap = document.createElement('div')
    Object.assign(titleWrap.style, { minWidth: '0', flex: '1 1 auto' })
    const title = document.createElement('div')
    title.textContent = 'Google Meet Audio Booster'
    Object.assign(title.style, { fontWeight: '700', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
    const subtitle = document.createElement('div')
    const outputCount = state.google.mode === 'media' ? state.google.mediaPipelines.length : state.google.slots.length
    subtitle.textContent = `${listItems.length} participant${listItems.length === 1 ? '' : 's'} · ${outputCount} ${state.google.mode === 'media' ? 'media stream' : 'audio slot'}${outputCount === 1 ? '' : 's'}`
    Object.assign(subtitle.style, { opacity: '0.68', fontSize: '11px', marginTop: '2px' })
    titleWrap.append(title, subtitle)
    const body = document.createElement('div')
    body.id = `${PANEL_ID}_body`
    const collapse = makeButton('', () => {
      state.panelCollapsed = !state.panelCollapsed
      updateCollapsedUi()
      onCollapse?.(state.panelCollapsed)
    })
    collapse.type = 'button'
    collapse.setAttribute('aria-controls', body.id)
    Object.assign(collapse.style, { width: '26px', height: '26px', padding: '0', fontSize: '16px', lineHeight: '16px', flex: '0 0 auto' })
    function updateCollapsedUi() {
      body.hidden = state.panelCollapsed
      body.style.display = state.panelCollapsed ? 'none' : 'block'
      header.style.marginBottom = state.panelCollapsed ? '0' : headerStyles.marginBottom
      const label = state.panelCollapsed ? 'Expand panel' : 'Collapse panel'
      collapse.textContent = state.panelCollapsed ? '+' : '−'
      collapse.title = label
      collapse.setAttribute('aria-label', label)
      collapse.setAttribute('aria-expanded', String(!state.panelCollapsed))
    }
    updateCollapsedUi()
    const close = makeButton('×', hide)
    close.setAttribute('aria-label', 'Close panel')
    Object.assign(close.style, { width: '26px', height: '26px', padding: '0', fontSize: '16px', lineHeight: '16px', flex: '0 0 auto' })
    const controls = document.createElement('div')
    Object.assign(controls.style, { display: 'flex', gap: '4px', flex: '0 0 56px' })
    controls.append(collapse, close)
    header.append(titleWrap, controls)
    panel.append(header, body)
    makeDraggable(panel, header, onSave)
    const list = document.createElement('div')
    Object.assign(list.style, { maxHeight: '310px', overflowY: 'auto', paddingRight: '4px' })
    if (!listItems.length) {
      const empty = document.createElement('div'); empty.textContent = 'Waiting for remote participants…'
      Object.assign(empty.style, { opacity: '0.75', padding: '8px 0' }); list.append(empty)
    }
    for (const participant of listItems) list.append(renderParticipantRow(participant, onGain))
    body.append(list)
    const footer = document.createElement('div')
    Object.assign(footer.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', marginTop: '9px', paddingTop: '8px', borderTop: '1px solid #3c4043' })
    const status = document.createElement('div')
    status.id = `${PANEL_ID}_status`; status.textContent = state.status
    Object.assign(status.style, { minHeight: '14px', marginTop: '0', color: '#bdc1c6', fontSize: '11px', lineHeight: '14px', flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
    const reset = makeButton('Reset all', () => { for (const participant of listItems) onGain(participant, 1); render() })
    reset.style.flex = '0 0 auto'
    footer.append(status, reset)
    const support = document.createElement('a')
    support.textContent = 'Support development'
    support.href = 'https://buymeacoffee.com/andreclemente'
    support.target = '_blank'
    support.rel = 'noopener noreferrer'
    support.referrerPolicy = 'no-referrer'
    support.title = 'Optional support — all features remain free'
    Object.assign(support.style, { display: 'block', color: '#8ab4f8', fontSize: '11px', textDecoration: 'none', lineHeight: '14px', minHeight: '14px', marginTop: '7px' })
    body.append(footer, support)
    state.panel = panel
    updateLiveUi()
    recoverPosition(panel)
    if (focusKey !== undefined && focusIndex >= 0) {
      const row = [...panel.querySelectorAll('[data-participant-key]')].find(item => item.dataset.participantKey === focusKey)
      row?.querySelectorAll('button, input')[focusIndex]?.focus({ preventScroll: true })
    } else if (focusLabel) {
      [...panel.querySelectorAll('button, input, a')].find(item => (item.getAttribute('aria-label') || item.textContent) === focusLabel)?.focus({ preventScroll: true })
    }
  }
  function show() { state.closed = false; render(); if (state.panel) state.panel.style.display = 'block' }
  function hide() { state.closed = true; if (state.panel) state.panel.style.display = 'none' }
  function toggle() { state.closed ? show() : hide() }
  return { render, show, hide, toggle, updateLiveUi }
}

function recoverPosition(panel) {
  const rect = panel.getBoundingClientRect()
  if (!Number.isFinite(globalThis.innerWidth) || !Number.isFinite(globalThis.innerHeight)) return
  const left = Math.max(8, Math.min(rect.left, globalThis.innerWidth - rect.width - 8))
  const top = Math.max(8, Math.min(rect.top, globalThis.innerHeight - rect.height - 8))
  if (left !== rect.left || top !== rect.top) Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, right: 'auto' })
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
  globalThis.addEventListener('resize', () => recoverPosition(panel))
  globalThis.addEventListener('mousemove', event => {
    const start = panel.__boosterDrag
    if (!start) return
    panel.style.left = `${Math.max(8, start.left + event.clientX - start.x)}px`
    panel.style.top = `${Math.max(8, start.top + event.clientY - start.y)}px`
    panel.style.right = 'auto'
    recoverPosition(panel)
  })
  globalThis.addEventListener('mouseup', () => {
    if (!panel.__boosterDrag) return
    panel.__boosterDrag = null
    const rect = panel.getBoundingClientRect()
    onSave({ left: rect.left, top: rect.top })
  })
}
