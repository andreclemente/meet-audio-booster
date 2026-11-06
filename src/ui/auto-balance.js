import { AUTO_HORIZON_MS, AUTO_MAX_SPREAD_DB } from '../platforms/google-meet/levels.js'

// Every voice is brought toward the same fixed comfortable level (owner
// decision): one speaker or many, no comparison between people. -20 dB is
// where voices sat in real calls the owner judged comfortable at 100%.
export const AUTO_TARGET_DB = -20
// Owner-approved tighter tolerance: act when a voice is more than 1 dB off
// the level AND the 95% interval of its measured level excludes the target,
// so estimation noise alone never moves a slider.
export const AUTO_DEADBAND_DB = 1
export const AUTO_STEP_DB = 0.1

// Session-only policy. A retained automatic value is not a new preference.
// Turn-taking: sustained-error evidence keeps accumulating across other
// people's turns within the evidence horizon.
export function createAutoBalance({ participants, levels, onGain }) {
  // targetDb stays null ("learning") until a first voice is confidently measured.
  let enabled = false, startedAt = 0, targetDb = null
  const consumed = new Map(), qualification = new Map()
  const firstSeen = new WeakMap()
  function stop() { enabled = false; targetDb = null; consumed.clear(); qualification.clear() }
  function invalidate(now, { reason } = {}) {
    startedAt = now
    if (reason !== 'compatible-native-gain') targetDb = null
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
    if (targetDb === null) targetDb = AUTO_TARGET_DB
    const error = targetDb - (level.autoDb + 20 * Math.log10(person.value))
    const direction = Math.sign(error)
    if (Math.abs(error) <= Math.max(AUTO_DEADBAND_DB, level.autoSpread / 2)) { qualification.delete(person.key); return }
    const old = qualification.get(person.key)
    const count = old?.person === person && old.direction === direction && now - old.at <= AUTO_HORIZON_MS ? old.count + 1 : 1
    qualification.set(person.key, { person, direction, count, at: now })
    // Three seconds of accepted evidence beyond warm-up; no catch-up jumps.
    if (count < 30) return
    const step = direction * AUTO_STEP_DB
    const value = Math.max(0.05, Math.min(6, person.value * 10 ** (step / 20)))
    if (value !== person.value) onGain(person, value, { automatic: true })
  }
  return { start, stop, tick, invalidate, get enabled() { return enabled }, get targetDb() { return targetDb } }
}
