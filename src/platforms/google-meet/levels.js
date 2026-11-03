// Per-participant speaking level, measured privately in memory.
//
// Meet mixes remote audio into pooled slots, so a slot is not a person. A
// level frame is only attributed to a participant while Meet's own activity
// model reports them as the one and only speaker AND routing has confirmed
// them. Levels are measured before the extension's gain (what Meet delivers),
// so the estimate does not depend on the user's slider. Nothing here is
// persisted, exported or logged; only a few dB numbers per present key.

export const LEVEL_SAMPLE_MS = 100
export const LEVEL_NOISE_FLOOR_DB = -55
export const LEVEL_WARMUP_FRAMES = 30
export const LEVEL_SETTLE_MS = 250
export const LEVEL_WINDOW_FRAMES = 300

export function meanSquare(buffer) {
  if (!buffer?.length) return 0
  let sum = 0
  for (let index = 0; index < buffer.length; index++) sum += buffer[index] * buffer[index]
  return sum / buffer.length
}

export function powerToDb(power) {
  return Number.isFinite(power) && power > 0 ? 10 * Math.log10(power) : -Infinity
}

// Taps on worklet slots: signal entering each booster gain (pre-volume).
export function sumTapPower(slots) {
  let power = 0
  for (const slot of slots || []) {
    const value = slot?.tap ? slot.tap.readMeanSquare() : 0
    if (Number.isFinite(value) && value > 0) power += value
  }
  return power
}

// Media pipelines already sample their source (before their gain) each tick.
export function sumPipelinePower(pipelines) {
  let power = 0
  for (const pipeline of pipelines || []) {
    const rms = Number(pipeline?.rms)
    if (Number.isFinite(rms) && rms > 0) power += rms * rms
  }
  return power
}

export function attributeLevelSample({ available, speakers, routingState, appliedParticipantKey, localPresentationActive } = {}) {
  if (available !== true || localPresentationActive) return null
  if (!Array.isArray(speakers) || speakers.length !== 1) return null
  const key = speakers[0]?.key
  if (!key || routingState !== 'confirmed-speaker' || appliedParticipantKey !== key) return null
  return key
}

// Windowed median of speech frames: robust to coughs, laughs and clipped
// bursts, and follows a changed microphone once the window turns over.
export function createTypicalLevelEstimator({ warmupFrames = LEVEL_WARMUP_FRAMES, window = LEVEL_WINDOW_FRAMES } = {}) {
  if (!(window >= 1)) throw new RangeError('window must be positive')
  const ring = new Float64Array(window)
  const scratch = new Float64Array(window)
  let next = 0, size = 0, total = 0, cached = null
  return {
    add(db) {
      if (!Number.isFinite(db)) return
      ring[next] = db
      next = (next + 1) % window
      size = Math.min(size + 1, window)
      total++
      cached = null
    },
    get frames() { return total },
    get typicalDb() {
      if (total < warmupFrames || !size) return null
      if (cached === null) {
        const sorted = scratch.subarray(0, size)
        sorted.set(ring.subarray(0, size))
        sorted.sort()
        const middle = size >> 1
        cached = size % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
      }
      return cached
    }
  }
}

export function createParticipantLevelMeter({
  sampleMs = LEVEL_SAMPLE_MS, noiseFloorDb = LEVEL_NOISE_FLOOR_DB, warmupFrames = LEVEL_WARMUP_FRAMES,
  settleMs = LEVEL_SETTLE_MS, window = LEVEL_WINDOW_FRAMES
} = {}) {
  const estimators = new Map()
  let lastSampleAt = -Infinity
  let settleKey = null
  let settleSince = 0
  let live = null

  function prune(participantKeys) {
    if (!estimators.size) return
    const present = participantKeys instanceof Set ? participantKeys : new Set(participantKeys || [])
    for (const key of estimators.keys()) if (!present.has(key)) estimators.delete(key)
    if (live && !present.has(live.key)) live = null
  }

  // Called on every routing tick; reads audio at most once per sampleMs and
  // only when a settled sole speaker is attributable.
  function tick({ now, participantKeys, attributedKey = null, readPower }) {
    prune(participantKeys)
    if (attributedKey !== settleKey) { settleKey = attributedKey; settleSince = now }
    if (!attributedKey || live?.key !== attributedKey) live = null
    if (now - lastSampleAt < sampleMs) return false
    lastSampleAt = now
    live = null
    if (!attributedKey || now - settleSince < settleMs) return false
    const db = powerToDb(readPower())
    if (!(db >= noiseFloorDb)) return false
    live = { key: attributedKey, db: Math.min(db, 0) }
    let estimator = estimators.get(attributedKey)
    if (!estimator) estimators.set(attributedKey, estimator = createTypicalLevelEstimator({ warmupFrames, window }))
    estimator.add(live.db)
    return true
  }

  function levelFor(key) {
    const estimator = estimators.get(key)
    return {
      liveDb: live?.key === key ? live.db : null,
      typicalDb: estimator ? estimator.typicalDb : null,
      frames: estimator ? estimator.frames : 0
    }
  }

  function reset() {
    estimators.clear()
    live = null
    settleKey = null
    settleSince = 0
    lastSampleAt = -Infinity
  }

  return { tick, levelFor, reset }
}
