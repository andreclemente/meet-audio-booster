import { isSelfText, extractNameFromParticipantRoot, isRecognizedParticipantRoot } from '../../shared/dom.js'

export function isSelfParticipant(root) {
  const text = root?.innerText || root?.textContent || ''
  if (isSelfText(text)) return true
  const labels = [...(root?.querySelectorAll?.('[aria-label]') || [])]
    .map(element => element.getAttribute('aria-label') || '')
  if (labels.some(label => /^(Reframe|Backgrounds and effects)$/i.test(label))) return true
  return labels.some(label => /^your\b|\byou are\b|\byou\s+\(/i.test(label) || /^(mute|unmute|turn (?:on|off)) your (?:microphone|camera)$/i.test(label))
}

export function extractGoogleName(root) {
  return extractNameFromParticipantRoot(root)
}

export function isGoogleParticipantSpeaking(root) {
  if (!root) return false
  if (root.matches?.('.BlxGDf') || root.querySelector?.('.BlxGDf')) return true
  const nodes = [root, ...(root.querySelectorAll?.('[aria-label], [data-is-speaking], [data-speaking], [aria-current]') || [])]
  return nodes.some(node => {
    const label = node.getAttribute?.('aria-label') || ''
    return /(^|[,\s])speaking([,\s]|$)|\bis speaking\b/i.test(label) ||
      /^(true|speaking|active)$/i.test(node.getAttribute?.('data-is-speaking') || '') ||
      /^(true|speaking|active)$/i.test(node.getAttribute?.('data-speaking') || '') ||
      /^(speaking|active)$/i.test(node.getAttribute?.('aria-current') || '')
  })
}

function scoreRoot(element) {
  return Math.min((element.innerText || '').length, 500) + Math.min(element.querySelectorAll?.('*').length || 0, 500)
}

export function scanMeetParticipants(root = document) {
  const roots = new Map()
  for (const element of root.querySelectorAll?.('[data-participant-id]') || []) {
    const participantId = element.getAttribute('data-participant-id')
    if (!participantId || !isRecognizedParticipantRoot(element)) continue
    const current = roots.get(participantId)
    if (!current || scoreRoot(element) > scoreRoot(current)) roots.set(participantId, element)
  }
  const found = []
  for (const [participantId, element] of roots) {
    if (isSelfParticipant(element)) continue
    const name = extractGoogleName(element)
    if (!name) continue
    found.push({ key: `id:${participantId}`, participantId, name, element, speaking: isGoogleParticipantSpeaking(element) })
  }
  return found
}

export function observeMeetParticipants(onChange, root = document.documentElement) {
  const observer = new MutationObserver(() => onChange())
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-participant-id'] })
  return observer
}
