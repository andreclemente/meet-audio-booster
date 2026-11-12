import { AUTO_HORIZON_MS, AUTO_MAX_SPREAD_DB } from '../platforms/google-meet/levels.js'

// Default comfortable level: -20 dB is where voices sat in real calls the
// owner judged comfortable at 100%. Used as the reference while fewer than
// two voices are measured, and as the centre of the reference clamp.
export const AUTO_TARGET_DB = -20
// The comfortable level is relative to the call (owner decision, 2.7.0): a
// shift that affects every voice alike (a quieter call, Meet's output level,
// measurement bias) must not move everyone. Once two or more voices are
// measured, the reference is the median measured voice of the call (before
// the user's volumes). A lone voice uses the comfortable default, but only a
// clearly quiet or loud one is corrected (AUTO_SOLO_TOLERANCE_DB), so the
// first voice is not pushed before the call's own level is known. The
// reference stays within AUTO_REFERENCE_RANGE_DB of the default; the user's
// − / + target is applied on top.
export const AUTO_REFERENCE_RANGE_DB = 6
export const AUTO_SOLO_TOLERANCE_DB = 4
export function referenceLevelDb(levels) {
  const values = levels.filter(Number.isFinite).sort((a, b) => a - b)
  if (values.length < 2) return AUTO_TARGET_DB
  const middle = values.length >> 1
  const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
  return Math.max(AUTO_TARGET_DB - AUTO_REFERENCE_RANGE_DB, Math.min(AUTO_TARGET_DB + AUTO_REFERENCE_RANGE_DB, median))
}

// Owner-approved tighter tolerance: once the call reference is known (two or
// more voices), act when a voice is more than 1 dB off it AND the 95% interval
// of its measured level excludes the target, so estimation noise alone never
// moves a slider.
export const AUTO_DEADBAND_DB = 1
export const AUTO_STEP_DB = 0.1

// Session-only policy. A retained automatic value is not a new preference.
// Turn-taking: sustained-error evidence keeps accumulating across other
// people's turns within the evidence horizon.
export function createAutoBalance({ participants, levels, onGain }) {
  // targetDb stays null ("learning") until a first voice is confidently measured.
  let enabled = false, startedAt = 0, targetDb = null, offsetDb = 0
  const consumed = new Map(), qualification = new Map(), known = new Map()
  const firstSeen = new WeakMap()
  function stop() { enabled = false; targetDb = null; consumed.clear(); qualification.clear(); known.clear() }
  function invalidate(now, { reason } = {}) {
    startedAt = now
    if (reason !== 'compatible-native-gain') { targetDb = null; known.clear() }
    consumed.clear(); qualification.clear()
  }
  function start(now) {
    stop(); enabled = true; invalidate(now)
    for (const person of participants()) firstSeen.set(person, now)
  }
  function tick(now, sampledKey) {
    if (!enabled) return
    const present = new Map(participants().map(person => [person.key, person]))
    for (const key of consumed.keys()) if (!present.has(key)) { consumed.delete(key); qualification.delete(key) }
    for (const key of known.keys()) if (!present.has(key)) known.delete(key)
    const person = present.get(sampledKey)
    if (person && !firstSeen.has(person)) firstSeen.set(person, now)
    // Only evidence since Auto started (or the person appeared) counts; the
    // meter filters it directly instead of waiting for old evidence to expire.
    const level = person && levels(person.key, { since: Math.max(startedAt, firstSeen.get(person)) })
    if (!person || !(person.value > 0 && person.value <= 6) || !Number.isFinite(level?.autoDb)
      || !(Number.isFinite(level.autoSupportMs) && level.autoSupportMs >= 6000)
      || !(Number.isFinite(level.autoInlierFrames) && level.autoInlierFrames >= 24)
      || !(Number.isFinite(level.autoInlierPortions) && level.autoInlierPortions >= 3)
      || !(level.autoSpread <= AUTO_MAX_SPREAD_DB) || !Number.isFinite(level.autoSince) || level.autoSince < Math.max(startedAt, firstSeen.get(person))
      || level.sampledAt !== now || now - startedAt < 1000 || consumed.get(person.key) === now) {
      // Fresh observed loss of confidence breaks sustained-error evidence.
      // Otherwise intermittent ready islands accumulate into a fictitious
      // three seconds and eventually chase periodic expression.
      if (person && level?.sampledAt === now && consumed.get(person.key) !== now) qualification.delete(person.key)
      return
    }
    // A sustained change first appears as outlier portions while the old level
    // still holds the majority. Pause (without resetting qualification) rather
    // than act on that stale level. Missing metadata fails closed.
    if (level.autoLatestAgrees !== true) return
    consumed.set(person.key, now)
    // Reference from the latest confident level (before the user's volumes)
    // of every present voice measured since Auto started or was invalidated.
    // Kept between turns: a quiet person's evidence going stale must not
    // drop them from the reference.
    known.set(person.key, level.autoDb)
    const voices = [...present.keys()].filter(key => known.has(key)).map(key => known.get(key))
    targetDb = referenceLevelDb(voices) + offsetDb
    const tolerance = voices.length < 2 ? AUTO_SOLO_TOLERANCE_DB : AUTO_DEADBAND_DB
    const error = targetDb - (level.autoDb + 20 * Math.log10(person.value))
    const direction = Math.sign(error)
    if (Math.abs(error) <= Math.max(tolerance, level.autoSpread / 2)) { qualification.delete(person.key); return }
    const old = qualification.get(person.key)
    const count = old?.person === person && old.direction === direction && now - old.at <= AUTO_HORIZON_MS ? old.count + 1 : 1
    qualification.set(person.key, { person, direction, count, at: now })
    // Three seconds of accepted evidence beyond warm-up; no catch-up jumps.
    if (count < 30) return
    const step = direction * AUTO_STEP_DB
    const value = Math.max(0.05, Math.min(6, person.value * 10 ** (step / 20)))
    if (value !== person.value) onGain(person, value, { automatic: true })
  }
  // The user's target level, as dB relative to the comfortable default.
  // Measurements are kept; corrections toward the new level must qualify again.
  function setTargetOffset(db) {
    if (!Number.isFinite(db) || db === offsetDb) return
    if (targetDb !== null) targetDb += db - offsetDb
    offsetDb = db
    qualification.clear()
  }
  return { start, stop, tick, invalidate, setTargetOffset, get enabled() { return enabled }, get targetDb() { return targetDb } }
}
