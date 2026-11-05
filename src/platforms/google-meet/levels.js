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
// Auto evidence horizon. In a group call each person speaks in short turns
// spread over minutes, so evidence is bounded by accepted speech, not by a
// short wall-clock window: up to 120 accepted samples (about 12-15 s of the
// person's own speech, so a sustained change takes over quickly) from at most
// the last 3 minutes. Silence alone never discards evidence; graph/meter
// invalidation still resets it.
export const AUTO_HORIZON_MS = 180000
export const AUTO_MAX_FRAMES = 120
// Level 95% interval about +/-2.9 dB (1.96 * 1.5): on the order of the 3 dB
// deadband; slow 0.05 dB steps and continued refinement absorb residual error.
export const AUTO_MAX_STANDARD_ERROR_DB = 1.5
export const AUTO_MAX_SPREAD_DB = 2 * 1.96 * AUTO_MAX_STANDARD_ERROR_DB
// The session comfort target locks once its references are known to +/-1 SE dB.
export const AUTO_LOCK_SPREAD_DB = 2 * 1.96 * 1

function median(values) {
  if (!values.length) return NaN
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// Duration-weighted median of portion summaries.
function weightedMedian(portions) {
  const ordered = [...portions].sort((a, b) => a.db - b.db)
  const total = ordered.reduce((sum, p) => sum + p.support, 0)
  let cumulative = 0
  for (let i = 0; i < ordered.length; i++) {
    cumulative += ordered[i].support
    if (cumulative < total / 2) continue
    return cumulative === total / 2 && ordered[i + 1] ? (ordered[i].db + ordered[i + 1].db) / 2 : ordered[i].db
  }
  return NaN
}

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
  // Auto evidence is disjoint, cadence-aware speaking-run portions, never the
  // visual median. No portion bridges attribution loss or a >350 ms read gap.
  // A 1.9 s portion is 20 nominal 100 ms samples; completed short turns need
  // >=600 ms and >=3 samples. Bounded by AUTO_MAX_FRAMES / AUTO_HORIZON_MS.
  const recent = new Map()
  const openPortions = new Map()
  function closePortion(key) {
    const portion = openPortions.get(key)
    if (portion) portion.closed = true
    openPortions.delete(key)
  }
  let clock = 0
  let lastSampleAt = -Infinity
  let settleKey = null
  let settleSince = 0
  let live = null

  function prune(participantKeys) {
    if (!estimators.size) return
    const present = participantKeys instanceof Set ? participantKeys : new Set(participantKeys || [])
    for (const key of estimators.keys()) if (!present.has(key)) estimators.delete(key)
    for (const key of recent.keys()) if (!present.has(key)) { recent.delete(key); openPortions.delete(key) }
    if (live && !present.has(live.key)) live = null
  }

  // Called on every routing tick; reads audio at most once per sampleMs and
  // only when a settled sole speaker is attributable.
  function tick({ now, participantKeys, attributedKey = null, readPower }) {
    if (now < clock) reset()
    clock = now
    prune(participantKeys)
    if (attributedKey !== settleKey) {
      closePortion(settleKey)
      settleKey = attributedKey; settleSince = now
    }
    if (!attributedKey || live?.key !== attributedKey) live = null
    if (now - lastSampleAt < sampleMs) return false
    lastSampleAt = now
    live = null
    if (!attributedKey || now - settleSince < settleMs) return false
    const db = powerToDb(readPower())
    if (!(db >= noiseFloorDb)) { closePortion(attributedKey); return false }
    live = { key: attributedKey, db: Math.min(db, 0) }
    let estimator = estimators.get(attributedKey)
    if (!estimator) estimators.set(attributedKey, estimator = createTypicalLevelEstimator({ warmupFrames, window }))
    estimator.add(live.db)
    let frames = recent.get(attributedKey) || []
    frames = frames.filter(frame => now - frame.at <= AUTO_HORIZON_MS)
    let portion = openPortions.get(attributedKey)
    if (portion && now - portion.until > 350) { closePortion(attributedKey); portion = null }
    if (!portion) {
      portion = { since: now, until: now, support: 0, count: 0, closed: false }
      openPortions.set(attributedKey, portion)
    }
    // Only consecutive accepted same-speaker observations support elapsed
    // speech. Bound interpolation to 250 ms; never credit the first sample,
    // attribution interruptions, invalid power, or gaps over 350 ms.
    portion.support += Math.min(250, now - portion.until)
    portion.until = now
    portion.count++
    frames.push({ at: now, db: live.db, portion })
    if (now - portion.since >= 1900) closePortion(attributedKey)
    if (frames.length > AUTO_MAX_FRAMES) frames.shift()
    recent.set(attributedKey, frames)
    return true
  }

  // options.since: ignore evidence before this time (e.g. before Auto was
  // enabled). A portion straddling it is a truncated edge and is excluded.
  function levelFor(key, { since = -Infinity } = {}) {
    const estimator = estimators.get(key)
    const frames = (recent.get(key) || []).filter(frame => clock - frame.at <= AUTO_HORIZON_MS && frame.at >= since)
    const groups = new Map()
    for (const frame of frames) {
      if (!groups.has(frame.portion)) groups.set(frame.portion, [])
      groups.get(frame.portion).push(frame.db)
    }
    const portions = []
    for (const [portion, values] of groups) {
      const support = portion.support
      // Never reuse a truncated edge as a new, conveniently rephased vote.
      if (!portion.closed || values.length !== portion.count || values.length < 3 || support < 600) continue
      values.sort((a, b) => a - b)
      const trim = Math.floor(values.length / 10)
      const core = values.slice(trim, values.length - trim)
      portions.push({ db: core.reduce((sum, db) => sum + db, 0) / core.length,
        support, count: values.length })
    }
    // Natural speech portions vary by several dB (live calls: MAD 2-3.4 dB),
    // so agreement of individual portions is not the right confidence test.
    // Instead: drop robust outliers (coughs, laughs, brief bursts: >3 robust
    // SD from the duration-weighted median), then estimate the level as the
    // duration-weighted MEAN of the remaining portions and require that mean
    // to be precise. A mean, unlike a median, does not flip between modes of
    // alternating loud/quiet passages as old evidence rolls out, so brief
    // periodic dynamics cannot produce corrections. Not speaker-intent inference.
    const center0 = weightedMedian(portions)
    const scale0 = Math.max(2, 1.4826 * median(portions.map(p => Math.abs(p.db - center0))))
    const totalSupport = portions.reduce((sum, p) => sum + p.support, 0)
    const typical = portions.filter(p => Math.abs(p.db - center0) <= 3 * scale0)
    // Outliers are a small minority by definition; never discard a whole
    // regime of bimodal speech (that would report one mode as the level).
    const agreeing = typical.reduce((sum, p) => sum + p.support, 0) * 4 >= totalSupport * 3 ? typical : portions
    const support = agreeing.reduce((sum, p) => sum + p.support, 0)
    const inlierFrames = agreeing.reduce((sum, p) => sum + p.count, 0)
    const center = support > 0 ? agreeing.reduce((sum, p) => sum + p.db * p.support, 0) / support : NaN
    // Standard error of the mean of independent portion summaries.
    const variance = agreeing.length > 1
      ? agreeing.reduce((sum, p) => sum + (p.db - center) ** 2, 0) / (agreeing.length - 1) : Infinity
    const standardError = Math.sqrt(variance / agreeing.length)
    // Preserve six nominal seconds (60 x 100 ms), not sixty callbacks.
    // 24 observations is the minimum at the bounded 250 ms support cadence.
    const ready = agreeing.length >= 3 && inlierFrames >= 24 && support >= 6000
      && Number.isFinite(center) && standardError <= AUTO_MAX_STANDARD_ERROR_DB
    const autoDb = ready ? center : null
    return {
      liveDb: live?.key === key ? live.db : null,
      typicalDb: estimator ? estimator.typicalDb : null,
      frames: estimator ? estimator.frames : 0,
      // Reported spread is the 95% interval width of the level estimate.
      autoDb, autoSpread: ready ? 2 * 1.96 * standardError : Infinity,
      // False while the newest completed portion is excluded as an outlier:
      // a sustained change starts as outliers, so the stale level must not act.
      autoLatestAgrees: ready && agreeing.includes(portions.at(-1)),
      autoSupportMs: support, autoInlierFrames: inlierFrames, autoInlierPortions: agreeing.length,
      autoPortions: portions.length, autoFrames: frames.length, autoSince: frames[0]?.at ?? null, sampledAt: frames.at(-1)?.at ?? null
    }
  }

  function reset() {
    estimators.clear()
    recent.clear()
    openPortions.clear()
    live = null
    settleKey = null
    settleSince = 0
    lastSampleAt = -Infinity
  }

  return { tick, levelFor, reset }
}
