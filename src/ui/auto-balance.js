// Session-only control policy. Driven exclusively by accepted routing samples;
// no timers, storage, audio ownership or visibility policy belongs here.
export function createAutoBalance({ participants, levels, onGain }) {
  let enabled = false, startedAt = 0, targetDb = null
  const heard = new Map(), consumed = new Map()
  function stop() { enabled = false; targetDb = null; heard.clear(); consumed.clear() }
  function invalidate(now) { startedAt = now; heard.clear(); consumed.clear() }
  function start(now) { stop(); enabled = true; invalidate(now) }
  function tick(now, sampledKey) {
    if (!enabled) return
    const people = participants()
    const present = new Map(people.map(person => [person.key, person]))
    for (const key of consumed.keys()) if (!present.has(key)) consumed.delete(key)
    for (const [key, record] of heard) {
      if (present.get(key) !== record.person || now - record.at > 15000 || record.person.value <= 0) heard.delete(key)
    }
    const person = present.get(sampledKey)
    const level = person && levels(person.key)
    // Never write on a mere routing/UI tick, silence, overlap or a reused
    // estimate. Require a new accepted sole-speaker sample from this session.
    if (!person || !(person.value > 0 && person.value <= 6) || !Number.isFinite(level?.autoDb)
      || level.autoFrames < 10 || !Number.isFinite(level.autoSince) || level.autoSince < startedAt
      || level.sampledAt !== now || now - startedAt < 1000
      || consumed.get(person.key) === now) return
    consumed.set(person.key, now)
    heard.set(person.key, { person, at: now, db: level.autoDb })
    if (targetDb === null) {
      if (heard.size < 2) return
      const post = [...heard.values()].map(record => record.db + 20 * Math.log10(record.person.value)).sort((a,b) => a-b)
      const middle = post.length >> 1
      // Fixed for this activation: never recenter on our own gain changes.
      targetDb = post.length % 2 ? post[middle] : (post[middle-1] + post[middle]) / 2
    }
    const error = targetDb - (level.autoDb + 20 * Math.log10(person.value))
    if (Math.abs(error) <= 1.5) return
    // At most 0.1 dB per new 100 ms speech sample (1 dB/s); never unmute.
    const step = Math.max(-0.1, Math.min(0.1, error))
    const value = Math.max(0.05, Math.min(6, person.value * 10 ** (step / 20)))
    if (value !== person.value) onGain(person, value, { automatic: true })
  }
  return { start, stop, tick, invalidate, get enabled() { return enabled }, get targetDb() { return targetDb } }
}
