import { extractNameFromParticipantRoot, isRecognizedParticipantRoot } from '../../shared/dom.js'

// Material icon names are ligatures, identical in every UI language. A screen
// share tile has presentation controls (zoom, open in full, annotations) and
// never a microphone indicator; a person's tile always has one.
const PRESENTATION_ICONS = new Set(['zoom_in', 'zoom_out', 'open_in_full', 'stylus_laser_pointer'])
const MICROPHONE_ICONS = new Set(['mic', 'mic_none', 'mic_off'])

function ownIcons(root) {
  const icons = new Set()
  for (const icon of root?.querySelectorAll?.(MATERIAL_ICON_SELECTOR) || []) {
    if (icon.closest && icon.closest('[data-participant-id]') !== root) continue
    icons.add((icon.textContent || '').trim())
  }
  return icons
}

// Every person's tile shows a microphone indicator; a screen share never does.
// Language-independent, and present before a share's own controls render.
export function hasMicrophoneIndicator(root) {
  const icons = ownIcons(root)
  return [...MICROPHONE_ICONS].some(icon => icons.has(icon))
}

export function isPresentationRoot(root) {
  if (!root?.getAttribute?.('data-participant-id')) return false
  const icons = ownIcons(root)
  if ([...MICROPHONE_ICONS].some(icon => icons.has(icon))) return false
  return [...PRESENTATION_ICONS].some(icon => icons.has(icon))
}

// Annotation tools are only offered to the presenter, on their own share.
export function isLocalPresentationRoot(root) {
  return isPresentationRoot(root) && ownIcons(root).has('stylus_laser_pointer')
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
  // Reframe is not rendered at all when the device has no camera; effects is
  // only ever offered on your own tile.
  return icons.has('visual_effects')
}

// Identity comes only from Meet's own controls (icon ligatures), never from
// UI text: the extension must behave the same in every language.
export function isSelfParticipant(root) {
  return hasOwnSelfControls(root)
}

export function extractGoogleName(root) {
  return extractNameFromParticipantRoot(root)
}

export function isGoogleParticipantSpeaking(root) {
  if (!root) return false
  if (root.matches?.('.BlxGDf') || root.querySelector?.('.BlxGDf')) return true
  const nodes = [root, ...(root.querySelectorAll?.('[data-is-speaking], [data-speaking], [aria-current]') || [])]
  return nodes.some(node => {
    return /^(true|speaking|active)$/i.test(node.getAttribute?.('data-is-speaking') || '') ||
      /^(true|speaking|active)$/i.test(node.getAttribute?.('data-speaking') || '') ||
      /^(speaking|active)$/i.test(node.getAttribute?.('aria-current') || '')
  })
}

function scoreRoot(element) {
  return Math.min((element.innerText || '').length, 500) + Math.min(element.querySelectorAll?.('*').length || 0, 500)
}

// Pass a controller-owned Set to retain verified IDs while Meet hides tiles.
// Omitted state is intentionally fresh: independent callers/meetings never share it.
export function scanMeetParticipants(root = document, selfIds = new Set(), presentationIds = new Set()) {
  const roots = new Map()
  for (const element of root.querySelectorAll?.('[data-participant-id]') || []) {
    const participantId = element.getAttribute('data-participant-id')
    if (!participantId) continue
    // Gather identity before either name validation or richest-root selection.
    if (isSelfParticipant(element)) selfIds.add(participantId)
    // A screen share is not a person: no row, never kept by membership. It is
    // NOT treated like self for speaker readings: share audio must stay an
    // unknown speaker (100%), never be skipped. Its controls can render after
    // the tile, so a row created earlier is dropped at once too.
    if (isPresentationRoot(element)) presentationIds.add(participantId)
    if (!isRecognizedParticipantRoot(element) || isLocalPresentationRoot(element)) continue
    const current = roots.get(participantId)
    if (!current || scoreRoot(element) > scoreRoot(current)) roots.set(participantId, element)
  }
  const found = []
  for (const [participantId, element] of roots) {
    if (selfIds.has(participantId) || presentationIds.has(participantId)) continue
    const name = extractGoogleName(element)
    if (!name) continue
    found.push({ key: `id:${participantId}`, participantId, name, element, speaking: isGoogleParticipantSpeaking(element), hasMicrophone: hasMicrophoneIndicator(element) })
  }
  return found
}

// Participants without a rendered tile this scan. Meet stops rendering tiles
// while someone presents and in large meetings, so a known participant stays
// present while Meet's trusted in-call membership still lists their id; a
// hidden tile is not a departure. Otherwise (left the call, or membership
// unavailable) the tile grace period applies. Verified self is removed now.
export function updateMissingParticipants(participants, found, { now, selfIds, presentationIds = new Set(), isMember = () => false, graceMs = 8000 }) {
  const excluded = id => selfIds.has(id) || presentationIds.has(id)
  for (const participant of participants) {
    if (participant.platform !== 'google-meet' || found.has(participant.key)) continue
    if (!excluded(participant.participantId) && isMember(participant.participantId)) {
      participant.present = true
      participant.lastSeenAt = now
      continue
    }
    participant.speaking = false
    if (excluded(participant.participantId) || now - participant.lastSeenAt > graceMs) participant.present = false
  }
}

export function observeMeetParticipants(onChange, root = document.documentElement) {
  const observer = new MutationObserver(() => onChange())
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-participant-id'] })
  return observer
}
