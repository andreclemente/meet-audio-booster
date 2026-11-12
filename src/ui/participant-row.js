import { buttonStyles, levelTrackStyles, levelFillStyles, levelTickStyles } from './styles.js'

export function makeButton(text, action) {
  const element = document.createElement('button')
  element.textContent = text
  Object.assign(element.style, buttonStyles)
  element.addEventListener('mouseenter', () => { if (element.dataset.muted !== 'true') element.style.background = '#3c4043' })
  element.addEventListener('mouseleave', () => { if (element.dataset.muted !== 'true') element.style.background = '#303134' })
  element.onclick = action
  return element
}

const SPEAKER = 'M560-131v-82q90-26 145-100t55-168q0-94-55-168T560-749v-82q124 28 202 125.5T840-481q0 127-78 224.5T560-131ZM120-360v-240h160l200-200v640L280-360H120Zm440 40v-322q47 22 73.5 66t26.5 96q0 51-26.5 94.5T560-320Z'
const MUTED = 'M792-56 671-177q-25 16-53 27.5T560-131v-82q14-5 27.5-10t25.5-12L480-368v208L280-360H120v-240h128L56-792l56-56 736 736-56 56Zm-8-232-58-58q17-31 25.5-65t8.5-70q0-94-55-168T560-749v-82q124 28 202 125.5T840-481q0 53-14.5 102T784-288ZM650-422l-90-90v-130q47 22 73.5 66t26.5 96q0 15-2.5 29.5T650-422ZM480-592 376-696l104-104v208Z'

// Mute icon state follows the volume: 0% is muted, from any control.
export function updateMuteButton(row, participant) {
  const button = row.querySelector('[data-role="mute"]')
  if (!button) return
  const muted = !(participant.value > 0)
  if (button.dataset.muted === String(muted)) return
  button.dataset.muted = String(muted)
  const label = `${muted ? 'Unmute' : 'Mute'} ${participant.name}`
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-pressed', String(muted))
  button.title = muted ? 'Unmute' : 'Mute'
  button.querySelector('path')?.setAttribute('d', muted ? MUTED : SPEAKER)
  Object.assign(button.style, { color: muted ? '#f28b82' : '#e8eaed', borderColor: muted ? '#f28b82' : '#5f6368', background: muted ? '#3c2a2a' : '#303134' })
  const slider = row.querySelector('[data-role="slider"]')
  if (slider) slider.style.opacity = muted ? '0.45' : '1'
}

export function renderParticipantRow(participant, onGain, { unmuteValue = () => 1 } = {}) {
  const row = document.createElement('div')
  row.dataset.participantKey = participant.key
  Object.assign(row.style, { padding: '9px 0', borderTop: '1px solid #3c4043' })
  const top = document.createElement('div')
  Object.assign(top.style, { display: 'grid', gridTemplateColumns: '1fr auto 48px', alignItems: 'center', gap: '7px', marginBottom: '5px' })
  const name = document.createElement('div')
  name.textContent = participant.name
  Object.assign(name.style, { fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
  const badge = document.createElement('span')
  badge.dataset.role = 'badge'
  Object.assign(badge.style, { minWidth: '8px', height: '8px', borderRadius: '999px', background: '#5f6368', boxShadow: '0 0 0 2px rgba(255,255,255,.06)' })
  const value = document.createElement('div')
  value.dataset.role = 'value'
  value.textContent = `${Math.round(participant.value * 100)}%`
  Object.assign(value.style, { opacity: '0.86', minWidth: '46px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' })
  top.append(name, badge, value)
  const slider = document.createElement('input')
  Object.assign(slider, { type: 'range', min: '0', max: '6', step: '0.05', value: String(participant.value) })
  slider.dataset.role = 'slider'
  slider.setAttribute('aria-label', `Volume for ${participant.name}`)
  Object.assign(slider.style, { width: '100%', margin: '0', display: 'block' })
  const set = (next, options) => { onGain(participant, next, options); slider.value = String(next); value.textContent = `${Math.round(next * 100)}%`; updateMuteButton(row, participant) }
  // While dragging, values are not remembered as the unmute volume; the
  // released value is (so dragging to 0% unmutes to the volume before it).
  slider.oninput = () => set(Number(slider.value), { dragging: true })
  slider.onchange = () => set(Number(slider.value))
  const mute = makeButton('', () => set(participant.value > 0 ? 0 : unmuteValue(participant)))
  mute.type = 'button'
  mute.dataset.role = 'mute'
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  for (const [k, v] of [['viewBox', '0 -960 960 960'], ['width', '18'], ['height', '18'], ['fill', 'currentColor'], ['aria-hidden', 'true'], ['focusable', 'false']]) svg.setAttribute(k, v)
  svg.append(document.createElementNS(ns, 'path'))
  mute.append(svg)
  Object.assign(mute.style, { width: '28px', height: '26px', padding: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' })
  const meter = renderLevelMeter()
  const controls = document.createElement('div')
  Object.assign(controls.style, { minWidth: '0' })
  controls.append(slider, meter)
  const line = document.createElement('div')
  Object.assign(line.style, { display: 'grid', gridTemplateColumns: '28px 1fr', alignItems: 'center', gap: '6px' })
  line.append(mute, controls)
  row.append(top, line)
  updateMuteButton(row, participant)
  return row
}

// Purely visual level line; updated in place by the panel's live update.
export function renderLevelMeter() {
  const track = document.createElement('div')
  track.dataset.role = 'level-track'
  track.setAttribute('aria-hidden', 'true')
  track.title = 'Not heard yet'
  Object.assign(track.style, levelTrackStyles)
  const fill = document.createElement('div')
  fill.dataset.role = 'level-fill'
  Object.assign(fill.style, levelFillStyles)
  const tick = document.createElement('div')
  tick.dataset.role = 'level-tick'
  Object.assign(tick.style, levelTickStyles)
  track.append(fill, tick)
  return track
}
