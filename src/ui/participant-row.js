import { buttonStyles } from './styles.js'

export function makeButton(text, action) {
  const element = document.createElement('button')
  element.textContent = text
  Object.assign(element.style, buttonStyles)
  element.addEventListener('mouseenter', () => { element.style.background = '#3c4043' })
  element.addEventListener('mouseleave', () => { element.style.background = '#303134' })
  element.onclick = action
  return element
}

export function renderParticipantRow(participant, onGain) {
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
  Object.assign(slider.style, { width: '100%', margin: '0' })
  slider.oninput = () => { const next = Number(slider.value); onGain(participant, next); value.textContent = `${Math.round(next * 100)}%` }
  const presets = document.createElement('div')
  Object.assign(presets.style, { display: 'flex', gap: '5px', marginTop: '7px', flexWrap: 'wrap' })
  for (const [text, gain] of [['Mute', 0], ['50%', 0.5], ['100%', 1], ['250%', 2.5]]) {
    presets.append(makeButton(text, () => { slider.value = String(gain); onGain(participant, gain); value.textContent = `${Math.round(gain * 100)}%` }))
  }
  row.append(top, slider, presets)
  return row
}
