// Pure helpers for the participant level line and the Balance action.
export const LEVEL_SCALE_MIN_DB = -60
export const VOLUME_MIN = 0.05
export const VOLUME_MAX = 6
export const VOLUME_STEP = 0.05

export function dbToScale(db) {
  if (typeof db !== 'number' || Number.isNaN(db)) return 0
  return Math.min(1, Math.max(0, (db - LEVEL_SCALE_MIN_DB) / -LEVEL_SCALE_MIN_DB))
}

// Level heard after the user's volume. Muted (0) or unknown has no level.
export function postVolumeDb(preDb, volume) {
  if (!Number.isFinite(preDb) || !Number.isFinite(volume) || volume <= 0) return null
  return preDb + 20 * Math.log10(volume)
}

export function roundVolume(value) {
  const stepped = Math.round(value / VOLUME_STEP) * VOLUME_STEP
  return Number(Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, stepped)).toFixed(2))
}

function typicalOf(participant, levels) {
  const typical = levels?.(participant.key)?.typicalDb
  return Number.isFinite(typical) ? typical : null
}

export function isBalanceEligible(participant, levels) {
  return Number.isFinite(participant?.value) && participant.value > 0 && typicalOf(participant, levels) !== null
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// Line up typical post-volume levels on the median of those already heard.
export function planBalance(participants, levels) {
  const eligible = participants.filter(participant => isBalanceEligible(participant, levels))
  if (eligible.length < 2) return { eligible, target: null, changes: [] }
  const post = eligible.map(participant => postVolumeDb(typicalOf(participant, levels), participant.value))
  const target = median(post)
  const changes = eligible.map((participant, index) => ({
    participant,
    from: participant.value,
    to: roundVolume(participant.value * 10 ** ((target - post[index]) / 20))
  }))
  return { eligible, target, changes }
}
