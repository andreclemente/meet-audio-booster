// Per-participant speaking level, measured privately in memory.
//
// Meet mixes remote audio into pooled slots, so a slot is not a person. A
// level frame is only attributed to a participant while Meet's own activity
// model reports them as the one and only speaker AND routing has confirmed
// them. Levels are measured before the extension's gain (what Meet delivers),
// after supported native playback gains, normalized by settled extension gain.
// Unsupported observed paths abstain; this is not a full-page graph census. Nothing here is
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

// Worklet control measurements must use one shared verified audible-path meter.
// Optional source taps are diagnostic only; failure must never select raw power.
export function sumTapPower(slots) {
  const meter = slots?.[0]?.audibleMeter
  if (!meter || !slots.every(slot => slot.audibleMeter === meter)) return NaN
  return meter.read(slots)
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
  // Auto Balance never consumes the long-lived visual median. Use only the
  // last 30 s / 120 accepted speech frames. Confidence compares independent
  // 20-frame portions (about 2 s of active speech), NOT syllable amplitudes.
  // Three complete portions spanning at least 4 s are needed. Each portion's
  // 10%-trimmed dB mean rejects brief bursts without preferring voiced peaks.
  // A <=4 dB range of portion summaries establishes temporal agreement;
  // ordinary 10–20 dB within-portion articulation is not itself instability.
  const recent = new Map()
  let clock = 0
  let lastSampleAt = -Infinity
  let settleKey = null
  let settleSince = 0
  let live = null

  function prune(participantKeys) {
    if (!estimators.size) return
    const present = participantKeys instanceof Set ? participantKeys : new Set(participantKeys || [])
    for (const key of estimators.keys()) if (!present.has(key)) estimators.delete(key)
    for (const key of recent.keys()) if (!present.has(key)) recent.delete(key)
    if (live && !present.has(live.key)) live = null
  }

  // Called on every routing tick; reads audio at most once per sampleMs and
  // only when a settled sole speaker is attributable.
  function tick({ now, participantKeys, attributedKey = null, readPower }) {
    if (now < clock) reset()
    clock = now
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
    let frames = recent.get(attributedKey) || []
    // A gap invalidates the entire short estimate, not just its timestamp.
    if (frames.length && now - frames.at(-1).at > 15000) frames = []
    frames = frames.filter(frame => now - frame.at <= 30000)
    frames.push({ at: now, db: live.db, sequence: (frames.at(-1)?.sequence || 0) + 1 })
    if (frames.length > 120) frames.shift()
    recent.set(attributedKey, frames)
    return true
  }

  function levelFor(key) {
    const estimator = estimators.get(key)
    const frames = (recent.get(key) || []).filter(frame => clock - frame.at <= 30000)
    const portions = []
    for (let index = 0; index + 20 <= frames.length; index++) {
      if (frames[index].sequence % 20 !== 1) continue
      const portion = frames.slice(index, index + 20)
      const sorted = portion.map(frame => frame.db).sort((a, b) => a - b)
      portions.push({ db: sorted.slice(2, 18).reduce((sum, db) => sum + db, 0) / 16,
        since: portion[0].at, until: portion.at(-1).at })
      index += 19
    }
    const summaries = portions.map(portion => portion.db).sort((a, b) => a - b)
    const middle = summaries.length >> 1
    const ready = portions.length >= 3 && portions.at(-1).until - portions[0].since >= 4000
    const autoDb = !ready ? null : summaries.length % 2 ? summaries[middle] : (summaries[middle - 1] + summaries[middle]) / 2
    return {
      liveDb: live?.key === key ? live.db : null,
      typicalDb: estimator ? estimator.typicalDb : null,
      frames: estimator ? estimator.frames : 0,
      autoDb, autoSpread: ready ? summaries.at(-1) - summaries[0] : Infinity,
      autoPortions: portions.length, autoFrames: frames.length, autoSince: frames[0]?.at ?? null, sampledAt: frames.at(-1)?.at ?? null
    }
  }

  function reset() {
    estimators.clear()
    recent.clear()
    live = null
    settleKey = null
    settleSince = 0
    lastSampleAt = -Infinity
  }

  return { tick, levelFor, reset }
}
