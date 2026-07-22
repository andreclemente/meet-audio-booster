const CONTROL_WORDS = new Set([
  'people', 'person', 'group', 'chat', 'meeting details', 'more options',
  'audio settings', 'video settings', 'settings', 'close', 'leave call',
  'present now', 'raise hand', 'keep_outline', 'mic', 'mic_off', 'more_vert',
  'call_end', 'volume_up', 'videocam', 'videocam_off', 'devices'
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
    .replace(/,\s*(?:muted|not muted|speaking)$/i, '')
    .replace(/\s+is speaking$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isSelfText(value) {
  return /(^|[\s(])you([\s)]|$)/i.test(value || '')
}

export function isValidParticipantName(value) {
  const name = cleanName(value)
  if (!name || name.length > 80 || isSelfText(name)) return false
  const lower = name.toLocaleLowerCase()
  if (CONTROL_WORDS.has(lower)) return false
  if (/^(?:[a-z]+_){1,}[a-z]+$/.test(lower) || /^\d+$/.test(name)) return false
  return !/(?:microphone|camera|google meet|meeting|participant|presentation|screen)/i.test(name)
}

function extractCandidateName(element) {
  const explicit = cleanName(element.getAttribute?.('data-participant-name') || element.getAttribute?.('data-self-name'))
  if (isValidParticipantName(explicit)) return explicit

  const aggregate = cleanName(element.textContent)
  const childNames = [...(element.children || [])]
    .map(child => cleanName(child.textContent))
    .filter(isValidParticipantName)
  if (childNames.length >= 2 && childNames.every(name => name === childNames[0]) && aggregate === childNames.join('')) {
    return childNames[0]
  }
  return aggregate
}

export function extractNameFromParticipantRoot(root) {
  if (!root?.getAttribute?.('data-participant-id')) return null
  const candidates = root.querySelectorAll?.(PARTICIPANT_NAME_SELECTORS) || []
  for (const element of candidates) {
    if (!element.matches?.(PARTICIPANT_NAME_SELECTORS)) continue
    if (element.matches?.('button, [role="button"], [aria-hidden="true"]')) continue
    const name = extractCandidateName(element)
    if (isValidParticipantName(name)) return name
  }
  return null
}

export function isRecognizedParticipantRoot(root) {
  if (!root?.getAttribute?.('data-participant-id')) return false
  return Boolean(root.getAttribute('data-requested-participant-id') || extractNameFromParticipantRoot(root))
}
