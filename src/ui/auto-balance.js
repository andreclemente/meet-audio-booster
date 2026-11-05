// Session-only policy. Manual unity is the comfort anchor, never an automatic
// or pre-existing boost. A retained automatic value is not a new preference.
export function createAutoBalance({ participants, levels, onGain }) {
  let enabled = false, startedAt = 0, targetDb = null
  const heard = new Map(), consumed = new Map(), qualification = new Map()
  const baselines = new WeakMap(), automaticValues = new WeakMap(), firstSeen = new WeakMap()
  function stop() { enabled = false; targetDb = null; heard.clear(); consumed.clear(); qualification.clear() }
  function invalidate(now, { reason } = {}) {
    startedAt = now
    if (reason !== 'compatible-native-gain') targetDb = null
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
      if (present.get(key) !== record.person || now - record.at > 30000 || record.person.value <= 0) heard.delete(key)
    }
    for (const key of consumed.keys()) if (!present.has(key)) { consumed.delete(key); qualification.delete(key) }
    const person = present.get(sampledKey)
    const level = person && levels(person.key)
    if (person && !firstSeen.has(person)) firstSeen.set(person, now)
    if (!person || !(person.value > 0 && person.value <= 6) || !Number.isFinite(level?.autoDb)
      || !(Number.isFinite(level.autoSupportMs) && level.autoSupportMs >= 6000)
      || !(Number.isFinite(level.autoInlierFrames) && level.autoInlierFrames >= 24)
      || !(Number.isFinite(level.autoInlierPortions) && level.autoInlierPortions >= 3)
      || !(level.autoSpread <= 4) || !Number.isFinite(level.autoSince) || level.autoSince < Math.max(startedAt, firstSeen.get(person))
      || level.sampledAt !== now || now - startedAt < 1000 || consumed.get(person.key) === now) {
      // Fresh observed loss of confidence breaks sustained-error evidence.
      // Otherwise intermittent ready islands accumulate into a fictitious
      // three seconds and eventually chase periodic expression.
      if (person && level?.sampledAt === now && consumed.get(person.key) !== now) qualification.delete(person.key)
      return
    }
    if (!baselines.has(person)) baselines.set(person, person.value)
    consumed.set(person.key, now)
    heard.set(person.key, { person, at: now, db: level.autoDb })
    if (targetDb === null) {
      if (heard.size < 2) return
      const references = [...heard.values()].filter(r => Math.abs(baselines.get(r.person) - 1) < 0.001)
        .map(r => r.db).sort((a, b) => a - b)
      if (!references.length) return
      const middle = references.length >> 1
      targetDb = references.length % 2 ? references[middle] : (references[middle - 1] + references[middle]) / 2
    }
    const error = targetDb - (level.autoDb + 20 * Math.log10(person.value))
    const direction = Math.sign(error)
    if (Math.abs(error) <= 3) { qualification.delete(person.key); return }
    const old = qualification.get(person.key)
    const count = old?.person === person && old.direction === direction && now - old.at <= 15000 ? old.count + 1 : 1
    qualification.set(person.key, { person, direction, count, at: now })
    // Three seconds of accepted evidence beyond warm-up; no catch-up jumps.
    if (count < 30) return
    const step = direction * 0.05
    const value = Math.max(0.05, Math.min(6, person.value * 10 ** (step / 20)))
    if (value !== person.value) { automaticValues.set(person, value); onGain(person, value, { automatic: true }) }
  }
  function noteManual(person, value) { baselines.set(person, value); automaticValues.delete(person) }
  return { start, stop, tick, invalidate, noteManual, get enabled() { return enabled }, get targetDb() { return targetDb } }
}
