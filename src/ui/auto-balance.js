import { AUTO_HORIZON_MS, AUTO_MAX_SPREAD_DB, AUTO_LOCK_SPREAD_DB } from '../platforms/google-meet/levels.js'

// Session-only policy. Manual unity is the comfort anchor, never an automatic
// or pre-existing boost. A retained automatic value is not a new preference.
// Turn-taking: a reference stays valid, and sustained-error evidence keeps
// accumulating, across other people's turns within the evidence horizon.
export function createAutoBalance({ participants, levels, onGain }) {
  let enabled = false, startedAt = 0, targetDb = null, anchored = false
  const heard = new Map(), consumed = new Map(), qualification = new Map()
  const baselines = new WeakMap(), automaticValues = new WeakMap(), firstSeen = new WeakMap()
  function stop() { enabled = false; targetDb = null; anchored = false; heard.clear(); consumed.clear(); qualification.clear() }
  function invalidate(now, { reason } = {}) {
    startedAt = now
    if (reason !== 'compatible-native-gain') { targetDb = null; anchored = false }
    // A retained target stays locked: the voice that changed must not move it.
    else if (targetDb !== null) anchored = true
    heard.clear(); consumed.clear(); qualification.clear()
  }
  function start(now) {
    stop(); enabled = true; invalidate(now)
    for (const person of participants()) {
      firstSeen.set(person, now)
      if (!baselines.has(person) || person.value !== automaticValues.get(person)) baselines.set(person, person.value)
    }
  }
  function tick(now, sampledKey) {
    if (!enabled) return
    const present = new Map(participants().map(person => [person.key, person]))
    for (const [key, record] of heard) {
      if (present.get(key) !== record.person || now - record.at > AUTO_HORIZON_MS || record.person.value <= 0) heard.delete(key)
    }
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
    if (!baselines.has(person)) baselines.set(person, person.value)
    consumed.set(person.key, now)
    heard.set(person.key, { person, at: now, db: level.autoDb, spread: level.autoSpread })
    // Until locked, the comfort target follows the current reference estimates,
    // so an early noisy estimate cannot become a fixed wrong anchor. It locks
    // once its references are precise, or at the first automatic correction,
    // so a voice that later drifts cannot drag the target with it.
    if (targetDb === null || !anchored) {
      const references = heard.size < 2 ? [] : [...heard.values()].filter(r => Math.abs(baselines.get(r.person) - 1) < 0.001)
        .sort((a, b) => a.db - b.db)
      if (references.length) {
        const middle = references.length >> 1
        targetDb = references.length % 2 ? references[middle].db : (references[middle - 1].db + references[middle].db) / 2
        if (references.length >= 2 && references.every(r => r.spread <= AUTO_LOCK_SPREAD_DB)) anchored = true
      }
      if (targetDb === null) return
    }
    const error = targetDb - (level.autoDb + 20 * Math.log10(person.value))
    const direction = Math.sign(error)
    if (Math.abs(error) <= 3) { qualification.delete(person.key); return }
    const old = qualification.get(person.key)
    const count = old?.person === person && old.direction === direction && now - old.at <= AUTO_HORIZON_MS ? old.count + 1 : 1
    qualification.set(person.key, { person, direction, count, at: now })
    // Three seconds of accepted evidence beyond warm-up; no catch-up jumps.
    if (count < 30) return
    const step = direction * 0.05
    const value = Math.max(0.05, Math.min(6, person.value * 10 ** (step / 20)))
    if (value !== person.value) { anchored = true; automaticValues.set(person, value); onGain(person, value, { automatic: true }) }
  }
  function noteManual(person, value) { baselines.set(person, value); automaticValues.delete(person) }
  return { start, stop, tick, invalidate, noteManual, get enabled() { return enabled }, get targetDb() { return targetDb } }
}
