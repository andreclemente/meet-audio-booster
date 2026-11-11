import { LEGACY_STORAGE_KEYS, STORAGE_KEY } from './shared/constants.js'

export const AUTO_TARGET_PERCENTS = [70, 80, 90, 100, 110, 120, 130, 140]
const defaultAutoBalance = () => ({ enabled: false, target: 100 })
const defaults = () => ({ gains: {}, position: null, collapsed: false, autoBalance: defaultAutoBalance() })

// Auto Balance on/off and its target level are user preferences, remembered
// across meetings. Unknown or out-of-range values fall back to the defaults.
function sanitizeAutoBalance(value) {
  if (!value || typeof value !== 'object') return defaultAutoBalance()
  return {
    enabled: value.enabled === true,
    target: AUTO_TARGET_PERCENTS.includes(value.target) ? value.target : 100
  }
}

function sanitize(value) {
  if (!value || typeof value !== 'object') return defaults()
  return {
    gains: value.gains && typeof value.gains === 'object' ? value.gains : {},
    position: value.position && Number.isFinite(value.position.left) && Number.isFinite(value.position.top)
      ? { left: value.position.left, top: value.position.top } : null,
    collapsed: value.collapsed === true,
    autoBalance: sanitizeAutoBalance(value.autoBalance)
  }
}

export function loadSettings(storage = globalThis.localStorage) {
  if (!storage) return defaults()
  for (const key of [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]) {
    try {
      const raw = storage.getItem(key)
      if (raw === null) continue
      const settings = sanitize(JSON.parse(raw))
      if (key !== STORAGE_KEY && !saveSettings(storage, settings)) continue
      return settings
    } catch {}
  }
  return defaults()
}

export function saveSettings(storage = globalThis.localStorage, settings) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(sanitize(settings)))
    return true
  } catch {
    return false
  }
}

export function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

export function participantStorageKeys(participant) {
  const keys = []
  if (participant?.participantId) keys.push(`${participant.platform}:id:${participant.participantId}`)
  const name = normalizeName(participant?.name)
  if (name) keys.push(`${participant.platform}:name:${name}`)
  return [...new Set(keys)]
}

export function getParticipantGain(settings, participant) {
  for (const key of participantStorageKeys(participant)) {
    const value = settings?.gains?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return 1
}

export function setParticipantGain(settings, participant, value) {
  settings.gains ||= {}
  // Saved under the participant id AND the name: Meet assigns a new id on
  // every join, so the name is what restores a volume after a rejoin.
  const gain = Math.max(0, Number(value) || 0)
  for (const key of participantStorageKeys(participant)) settings.gains[key] = gain
  return settings
}
