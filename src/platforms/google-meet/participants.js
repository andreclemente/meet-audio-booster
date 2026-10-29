import { extractNameFromParticipantRoot, isRecognizedParticipantRoot } from '../../shared/dom.js'

export function isLocalPresentationRoot(root) {
  if (!root?.getAttribute?.('data-participant-id')) return false
  if (extractNameFromParticipantRoot(root)) return false
  const labels = [...(root.querySelectorAll?.('[aria-label]') || [])]
    .map(element => element.getAttribute('aria-label') || '')
  const text = `${root.innerText || root.textContent || ''} ${labels.join(' ')}`
  return /\beveryone can see your annotations\b/i.test(text) &&
    /\bscroll\s*(?:&|and)\s*zoom your presentation in meet\b/i.test(text)
}

export function hasLocalPresentation(root = document) {
  return [...(root.querySelectorAll?.('[data-participant-id]') || [])].some(isLocalPresentationRoot)
}

const BUTTON_SELECTOR = 'button, [role="button"]'
const MATERIAL_ICON_SELECTOR = [
  ...['google-symbols', 'material-icons', 'material-icons-outlined',
    'material-icons-round', 'material-icons-sharp', 'material-icons-two-tone',
    'material-symbols-outlined', 'material-symbols-rounded', 'material-symbols-sharp']
    .flatMap(className => [`i.${className}`, `span.${className}`])
].join(', ')

function hasOwnSelfControls(root) {
  // The captured self tile owns both controls, including when camera-off
  // disables Reframe. Neither disabled state, translated labels nor names
  // identify self. Never borrow controls from a nested participant root.
  const icons = new Set()
  for (const button of root?.querySelectorAll?.(BUTTON_SELECTOR) || []) {
    if (button.closest?.('[data-participant-id]') !== root) continue
    for (const icon of button.querySelectorAll?.(MATERIAL_ICON_SELECTOR) || []) {
      if (icon.closest?.('[data-participant-id]') !== root || icon.closest?.(BUTTON_SELECTOR) !== button) continue
      icons.add((icon.textContent || '').trim())
    }
  }
  return icons.has('frame_person') && icons.has('visual_effects')
}

function ownParticipantText(root) {
  // Ignore nested participant text for the legacy English '(You)' fallback too.
  if (!root?.childNodes) return root?.innerText || root?.textContent || ''
  function read(node) {
    if (node !== root && node.hasAttribute?.('data-participant-id')) return ''
    if (node.nodeType === 3) return node.textContent || ''
    return [...(node.childNodes || [])].map(read).join(' ')
  }
  return read(root)
}

export function isSelfParticipant(root) {
  if (hasOwnSelfControls(root)) return true
  const text = ownParticipantText(root)
  if (/(^|\s)\(you\)(?=\s|$)/i.test(text)) return true
  const labels = [...(root?.querySelectorAll?.('[aria-label]') || [])]
    .filter(element => !element.closest || element.closest('[data-participant-id]') === root)
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

// Pass a controller-owned Set to retain verified IDs while Meet hides tiles.
// Omitted state is intentionally fresh: independent callers/meetings never share it.
export function scanMeetParticipants(root = document, selfIds = new Set()) {
  const roots = new Map()
  for (const element of root.querySelectorAll?.('[data-participant-id]') || []) {
    const participantId = element.getAttribute('data-participant-id')
    if (!participantId) continue
    // Gather identity before either name validation or richest-root selection.
    if (isSelfParticipant(element)) selfIds.add(participantId)
    if (!isRecognizedParticipantRoot(element) || isLocalPresentationRoot(element)) continue
    const current = roots.get(participantId)
    if (!current || scoreRoot(element) > scoreRoot(current)) roots.set(participantId, element)
  }
  const found = []
  for (const [participantId, element] of roots) {
    if (selfIds.has(participantId)) continue
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
