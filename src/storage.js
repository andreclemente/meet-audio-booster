import { LEGACY_STORAGE_KEYS, STORAGE_KEY } from './shared/constants.js'

const defaults = () => ({ gains: {}, position: null })

function sanitize(value) {
  if (!value || typeof value !== 'object') return defaults()
  return {
    gains: value.gains && typeof value.gains === 'object' ? value.gains : {},
    position: value.position && typeof value.position === 'object' ? value.position : null
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
  const key = participantStorageKeys(participant)[0]
  if (key) settings.gains[key] = Math.max(0, Number(value) || 0)
  return settings
}
