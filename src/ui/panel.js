import { PANEL_ID } from '../shared/constants.js'
import { panelStyles, headerStyles } from './styles.js'
import { makeButton, renderParticipantRow } from './participant-row.js'
import { postVolumeDb, dbToScale } from './balance.js'
import { createAutoBalance } from './auto-balance.js'
import { AUTO_TARGET_PERCENTS } from '../storage.js'

// Inline SVG icons (no icon font, no remote assets); labels come from
// aria-label/title, never from translated page text.
const ICONS = {
  balance: 'M440-120v-240h80v80h320v80H520v80h-80Zm-320-80v-80h240v80H120Zm160-160v-80H120v-80h160v-80h80v240h-80Zm160-80v-80h400v80H440Zm160-160v-240h80v80h160v80H680v80h-80Zm-480-80v-80h400v80H120Z',
  reset: 'M280-200v-80h284q63 0 109.5-40T720-420q0-60-46.5-100T564-560H312l104 104-56 56-200-200 200-200 56 56-104 104h252q97 0 166.5 63T800-420q0 94-69.5 157T564-200H280Z',
  minus: 'M200-440v-80h560v80H200Z',
  plus: 'M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z'
}
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 -960 960 960'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'currentColor'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', ICONS[name])
  svg.append(path)
  return svg
}
function iconButton(name, label, action) {
  const button = makeButton('', action)
  button.type = 'button'
  button.append(icon(name))
  button.setAttribute('aria-label', label)
  button.title = label
  Object.assign(button.style, { width: '28px', height: '26px', padding: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' })
  return button
}
const targetDbOf = percent => 20 * Math.log10(percent / 100)

// Reuse the existing footer: automatic learning/state, otherwise routing status.
export function statusText(state, now = Date.now()) {
  if (state.autoBalanceEnabled) return state.autoBalanceReady ? 'Auto Balance on' : 'Learning levels…'
  const notice = state.statusNotice
  return notice && now < notice.until ? notice.message : state.status
}

function setStyle(element, name, value) {
  if (element && element.style[name] !== value) element.style[name] = value
}

function updateLevelMeter(row, participant, levels) {
  const track = row.querySelector('[data-role="level-track"]')
  if (!track) return
  const level = levels?.(participant.key) || null
  const live = postVolumeDb(level?.liveDb, participant.value)
  const typical = postVolumeDb(level?.typicalDb, participant.value)
  const [fill, tick] = track.children
  setStyle(fill, 'width', live === null ? '0%' : `${(dbToScale(live) * 100).toFixed(2)}%`)
  setStyle(tick, 'display', typical === null ? 'none' : 'block')
  if (typical !== null) setStyle(tick, 'left', `${(dbToScale(typical) * 100).toFixed(2)}%`)
  const title = Number.isFinite(level?.typicalDb) ? 'Typical speaking level after your volume' : 'Not heard yet'
  if (track.title !== title) track.title = title
}

export function createPanelController(state, { participants, levels = () => null, onGain, onSave, onCollapse, onAutoSettings = () => {} }) {
  const auto = createAutoBalance({ participants, levels, onGain })
  state.autoBalanceEnabled = false
  state.settings.autoBalance ??= { enabled: false, target: 100 }
  auto.setTargetOffset(targetDbOf(state.settings.autoBalance.target))
  let balanceButton = null, targetParts = null
  function saveAuto(changes) {
    state.settings.autoBalance = { ...state.settings.autoBalance, ...changes }
    onAutoSettings(state.settings.autoBalance)
  }
  function updateBalanceButton() {
    const button = balanceButton
    if (button) {
      const label = auto.enabled ? 'Auto Balance: on' : 'Auto Balance: off'
      button.setAttribute('aria-label', 'Auto Balance')
      button.setAttribute('aria-pressed', String(auto.enabled))
      if (button.title !== label) button.title = label
      setStyle(button, 'color', auto.enabled ? '#202124' : '#8ab4f8')
      setStyle(button, 'background', auto.enabled ? '#8ab4f8' : '#303134')
      setStyle(button, 'borderColor', '#8ab4f8')
      button.disabled = false
    }
    if (targetParts) {
      const target = state.settings.autoBalance.target
      const text = `${target}%`
      if (targetParts.value.textContent !== text) targetParts.value.textContent = text
      // aria-disabled (not disabled) keeps keyboard focus on the button at a limit.
      for (const [button, atLimit] of [[targetParts.lower, target <= AUTO_TARGET_PERCENTS[0]], [targetParts.raise, target >= AUTO_TARGET_PERCENTS.at(-1)]]) {
        button.setAttribute('aria-disabled', String(atLimit))
        setStyle(button, 'opacity', atLimit ? '0.4' : '1')
        setStyle(button, 'cursor', atLimit ? 'default' : 'pointer')
      }
      setStyle(targetParts.group, 'opacity', auto.enabled ? '1' : '0.55')
    }
  }
  // persist=false when the page/controller shuts down: the user's choice stays.
  function stopAuto({ persist = true } = {}) {
    // Only a user stopping an Auto Balance that was actually running stores
    // off (e.g. not when audio was unavailable and it was never restored).
    const wasRunning = auto.enabled
    auto.stop()
    state.autoBalanceEnabled = false
    state.autoBalanceReady = false
    if (persist && wasRunning && state.settings.autoBalance.enabled) saveAuto({ enabled: false })
    updateBalanceButton()
    const status = document.getElementById(`${PANEL_ID}_status`)
    if (status) status.textContent = statusText(state)
  }
  function startAuto() {
    auto.start(Date.now()); state.autoBalanceEnabled = true; state.autoBalanceReady = false
  }
  function manualGain(participant, value) {
    stopAuto()
    onGain(participant, value)
  }
  function toggleAuto() {
    if (auto.enabled) stopAuto()
    else { startAuto(); saveAuto({ enabled: true }) }
    updateLiveUi()
  }
  // Restore the remembered on/off state when a meeting page starts.
  function restoreAuto() {
    if (state.settings.autoBalance.enabled && !auto.enabled) { startAuto(); updateLiveUi() }
  }
  // Settings changed in another tab: follow its target level. Its on/off
  // choice applies to the next meeting; a running Auto here is not toggled.
  function syncAutoSettings() {
    auto.setTargetOffset(targetDbOf(state.settings.autoBalance.target))
    updateLiveUi()
  }
  function stepTarget(direction) {
    const list = AUTO_TARGET_PERCENTS, index = list.indexOf(state.settings.autoBalance.target)
    const next = list[Math.max(0, Math.min(list.length - 1, (index < 0 ? list.indexOf(100) : index) + direction))]
    if (next === state.settings.autoBalance.target) return
    saveAuto({ target: next })
    auto.setTargetOffset(targetDbOf(next))
    updateLiveUi()
  }
  function autoTick(now, sampledKey) {
    auto.tick(now, sampledKey)
    state.autoBalanceReady = auto.targetDb !== null
  }
  function updateLiveUi() {
    if (!state.panel?.isConnected) return
    updateBalanceButton()
    const status = document.getElementById(`${PANEL_ID}_status`)
    if (status) status.textContent = statusText(state)
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
      updateLevelMeter(row, participant, levels)
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
    function toggleCollapsed() {
      state.panelCollapsed = !state.panelCollapsed
      updateCollapsedUi()
      onCollapse?.(state.panelCollapsed)
    }
    title.ondblclick = toggleCollapsed
    const collapse = makeButton('', toggleCollapsed)
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
    for (const participant of listItems) list.append(renderParticipantRow(participant, manualGain))
    body.append(list)
    const footer = document.createElement('div')
    Object.assign(footer.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', marginTop: '9px', paddingTop: '8px', borderTop: '1px solid #3c4043' })
    const status = document.createElement('div')
    status.id = `${PANEL_ID}_status`; status.textContent = statusText(state)
    Object.assign(status.style, { minHeight: '14px', marginTop: '0', color: '#bdc1c6', fontSize: '11px', lineHeight: '14px', flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
    const reset = iconButton('reset', 'Reset all participant volumes to 100%', () => { stopAuto(); for (const participant of participants()) onGain(participant, 1); render() })
    reset.title = 'Reset all to 100%'
    const group = document.createElement('div')
    group.dataset.role = 'auto-target'
    Object.assign(group.style, { display: 'inline-flex', alignItems: 'center', border: '1px solid #5f6368', borderRadius: '7px', overflow: 'hidden', flex: '0 0 auto' })
    const lower = iconButton('minus', 'Lower Auto Balance target', () => stepTarget(-1))
    const raise = iconButton('plus', 'Raise Auto Balance target', () => stepTarget(1))
    for (const button of [lower, raise]) Object.assign(button.style, { width: '22px', height: '24px', border: '0', borderRadius: '0' })
    const value = document.createElement('div')
    value.dataset.role = 'auto-target-value'
    value.title = 'Auto Balance target level'
    value.setAttribute('aria-live', 'polite')
    Object.assign(value.style, { minWidth: '34px', textAlign: 'center', fontSize: '11px', lineHeight: '24px', color: '#e8eaed', borderLeft: '1px solid #5f6368', borderRight: '1px solid #5f6368', fontVariantNumeric: 'tabular-nums' })
    group.append(lower, value, raise)
    targetParts = { group, lower, value, raise }
    balanceButton = iconButton('balance', 'Auto Balance', toggleAuto)
    balanceButton.onmouseenter = balanceButton.onmouseleave = updateBalanceButton
    footer.append(status, group, balanceButton, reset)
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
  return { render, show, hide, toggle, updateLiveUi, autoTick, stopAuto, restoreAuto, syncAutoSettings, invalidateAuto: (now, metadata) => auto.invalidate(now, metadata) }
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
