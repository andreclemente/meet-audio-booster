import { LEGACY_STORAGE_KEYS, STORAGE_KEY } from './shared/constants.js'

export const AUTO_TARGET_PERCENTS = [70, 80, 90, 100, 110, 120, 130, 140]
const defaultAutoBalance = () => ({ enabled: false, target: 100 })
const defaults = () => ({ gains: {}, unmute: {}, position: null, collapsed: false, autoBalance: defaultAutoBalance() })

// Auto Balance on/off and its target level are user preferences, remembered
// across meetings. Unknown or out-of-range values fall back to the defaults.
function sanitizeAutoBalance(value) {
  if (!value || typeof value !== 'object') return defaultAutoBalance()
  return {
    enabled: value.enabled === true,
    target: AUTO_TARGET_PERCENTS.includes(value.target) ? value.target : 100
  }
}

// Volume to restore on unmute, per participant key (only audible values).
function sanitizeUnmute(value) {
  const unmute = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unmute
  for (const [key, gain] of Object.entries(value)) if (typeof gain === 'number' && gain > 0 && gain <= 6) unmute[key] = gain
  return unmute
}
function sanitize(value) {
  if (!value || typeof value !== 'object') return defaults()
  return {
    gains: value.gains && typeof value.gains === 'object' ? value.gains : {},
    unmute: sanitizeUnmute(value.unmute),
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

// Another Meet tab saved settings: adopt them, so this tab's next save does
// not write back its older copy (whole-object saves). Same object identity.
export function watchSettings(settings, { storage = globalThis.localStorage, listen = (name, handler) => globalThis.addEventListener?.(name, handler), onChange = () => {} } = {}) {
  listen('storage', event => {
    if (event?.key !== STORAGE_KEY || event.storageArea && event.storageArea !== storage) return
    Object.assign(settings, loadSettings(storage))
    onChange(settings)
  })
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

// Volume an unmute restores: the last audible volume saved for this person,
// otherwise 100%.
export function getParticipantUnmute(settings, participant) {
  for (const key of participantStorageKeys(participant)) {
    const value = settings?.unmute?.[key]
    if (typeof value === 'number' && value > 0 && value <= 6) return value
  }
  return 1
}
// Track the volume an unmute should restore, before `next` is applied: the
// volume a person had before their first change here, then every audible
// volume that was settled (not one passed mid-drag), so dragging to 0% and
// unmuting returns to where the drag started.
export function rememberAudible(participant, next, { dragging = false } = {}) {
  if (!(participant.unmuteValue > 0) && participant.value > 0) participant.unmuteValue = participant.value
  if (next > 0 && !dragging) participant.unmuteValue = next
  return participant.unmuteValue
}
export function setParticipantUnmute(settings, participant, value) {
  if (!(typeof value === 'number' && value > 0 && value <= 6)) return settings
  settings.unmute ||= {}
  for (const key of participantStorageKeys(participant)) settings.unmute[key] = value
  return settings
}
export function setParticipantGain(settings, participant, value) {
  settings.gains ||= {}
  // Saved under the participant id AND the name: Meet assigns a new id on
  // every join, so the name is what restores a volume after a rejoin.
  const gain = Math.max(0, Number(value) || 0)
  for (const key of participantStorageKeys(participant)) settings.gains[key] = gain
  return settings
}
