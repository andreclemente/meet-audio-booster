// Material icon ligatures: the same in every UI language.
const ICON_WORDS = new Set([
  'keep_outline', 'keep_off', 'mic', 'mic_none', 'mic_off', 'more_vert', 'call_end',
  'volume_up', 'volume_off', 'videocam', 'videocam_off', 'devices', 'visual_effects', 'frame_person',
  'person', 'group', 'chat', 'people'
])

export const PARTICIPANT_NAME_SELECTORS = [
  '[data-self-name]',
  '[data-participant-name]',
  '.zWGUib',
  '.ZjFb7c',
  '.XEazBc',
  '[jsname="EydYod"]'
].join(', ')

export function cleanName(value) {
  return String(value || '')
    .replace(/\s+\(.*?\)$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isValidParticipantName(value) {
  const name = cleanName(value)
  if (!name || name.length > 80) return false
  if (ICON_WORDS.has(name.toLocaleLowerCase())) return false
  return !/^(?:[a-z]+_){1,}[a-z]+$/.test(name.toLocaleLowerCase()) && !/^\d+$/.test(name)
}

function participantNameLeaves(element) {
  const names = []
  const pending = [...(element.children || [])]
  while (pending.length && names.length < 8) {
    const child = pending.shift()
    const children = [...(child.children || [])]
    if (children.length) pending.unshift(...children)
    else {
      const name = cleanName(child.textContent)
      if (isValidParticipantName(name)) names.push(name)
    }
  }
  return names
}

function extractCandidateName(element) {
  const explicit = cleanName(element.getAttribute?.('data-participant-name') || element.getAttribute?.('data-self-name'))
  if (isValidParticipantName(explicit)) return explicit

  const aggregate = cleanName(element.textContent)
  const leafNames = participantNameLeaves(element)
  if (leafNames.length >= 2 && leafNames.every(name => name === leafNames[0]) && aggregate === leafNames.join('')) {
    return leafNames[0]
  }
  return aggregate
}

export function extractNameFromParticipantRoot(root) {
  if (!root?.getAttribute?.('data-participant-id')) return null
  const candidates = root.querySelectorAll?.(PARTICIPANT_NAME_SELECTORS) || []
  // Meet's own control labels/tooltips in this tile, in whatever language the
  // UI uses: text equal to one of them is a control, not a person.
  const controlLabels = new Set()
  for (const element of root.querySelectorAll?.('[aria-label], [data-tooltip]') || []) {
    for (const attr of ['aria-label', 'data-tooltip']) {
      const value = cleanName(element.getAttribute?.(attr)).toLocaleLowerCase()
      if (value) controlLabels.add(value)
    }
  }
  for (const element of candidates) {
    if (!element.matches?.(PARTICIPANT_NAME_SELECTORS)) continue
    if (element.matches?.('button, [role="button"], [aria-hidden="true"]')) continue
    const name = extractCandidateName(element)
    if (isValidParticipantName(name) && !controlLabels.has(name.toLocaleLowerCase())) return name
  }
  return null
}

export function isRecognizedParticipantRoot(root) {
  if (!root?.getAttribute?.('data-participant-id')) return false
  return Boolean(root.getAttribute('data-requested-participant-id') || extractNameFromParticipantRoot(root))
}
