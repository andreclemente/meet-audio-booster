// Meet's activity service also keeps a Map of exactly the people in the call
// (including the local user and members without a rendered tile), keyed by
// the same participant id as `data-participant-id`. A leaver's id is removed
// within about a second; a rejoin gets a NEW id. The level Map keeps departed
// ids, so this Map, not the level Map, answers "still in the call".
//
// It is found structurally during the level registry's budgeted walk
// (activity-registry.js): a Map whose string keys cover every tile-resolved
// participant id and whose values are records, each with exactly one own data
// field holding a participant model for that key (same class as the tile
// activity models, validated by the caller's identity check). Only KEYS are
// used afterwards; records and ids never leave this closure.

const MAX_MEMBERS = 2048
const MAX_FIELDS = 64
const DISCOVERY_SAMPLE = 32
const ENTRIES_PER_TICK = 128
// Full key scans (new-key validation, level-key subset) run when the size
// changes, while validation is incomplete, or at least this often.
const FULL_SCAN_MS = 250
const MISMATCH_MS = 1000

const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get
const mapKeys = Map.prototype.keys
const mapEntries = Map.prototype.entries
const mapGet = Map.prototype.get
const mapHas = Map.prototype.has

function isObjectValue(value) { return value !== null && typeof value === 'object' }

function isLive(model) {
  try { return model.isDisposed() === false } catch { return false }
}

// Cheap walk-time shape test: bounded size, string keys, object values.
export function isMembershipShaped(map) {
  try {
    const size = mapSize.call(map)
    if (!(size >= 1 && size <= MAX_MEMBERS)) return false
    for (const [key, value] of mapEntries.call(map)) {
      if (typeof key !== 'string' || !key || !isObjectValue(value)) return false
    }
    return true
  } catch { return false }
}

// True when exactly one own data field of the record holds a participant
// model for `id` (getters are never invoked on the record).
export function recordHoldsParticipant(record, id, isParticipantModel) {
  try {
    if (!isObjectValue(record)) return false
    let found = 0
    let fields = 0
    for (const name in record) {
      if (++fields > MAX_FIELDS) return false
      let descriptor
      try { descriptor = Object.getOwnPropertyDescriptor(record, name) } catch { continue }
      if (!descriptor || !('value' in descriptor) || !isObjectValue(descriptor.value)) continue
      if (isParticipantModel(descriptor.value, id)) found++
    }
    return found === 1
  } catch { return false }
}

function readKeys(map) {
  try {
    const size = mapSize.call(map)
    if (!(size >= 1 && size <= MAX_MEMBERS)) return null
    const keys = []
    for (const key of mapKeys.call(map)) {
      if (typeof key !== 'string' || !key || keys.length >= MAX_MEMBERS) return null
      keys.push(key)
    }
    return keys
  } catch { return null }
}

function validEntry(map, id, isParticipantModel) {
  try { return mapHas.call(map, id) && recordHoldsParticipant(mapGet.call(map, id), id, isParticipantModel) } catch { return false }
}

// Discovery check for one walk candidate: every tile id plus a bounded sample
// of other entries must hold a matching participant model. The remaining
// entries are validated incrementally by update().
function passesDiscovery(map, ids, isParticipantModel) {
  if (!ids.every(id => validEntry(map, id, isParticipantModel))) return false
  const sample = (readKeys(map) || []).slice(0, DISCOVERY_SAMPLE)
  return sample.length > 0 && sample.every(id => validEntry(map, id, isParticipantModel))
}

// Trust rules (documented policy):
// - a walk that finishes with ids yields the candidate only when exactly one
//   distinct Map passes the discovery check; zero or several => untrusted;
// - a walk without tile ids (all tiles hidden) only re-checks that the current
//   Map is still reachable; an unfinished walk drops it;
// - every key is validated once (bounded per tick); trust requires all keys
//   validated, and any failing entry drops the Map;
// - each tick, every tile-resolved id must be a key and, while the level Map
//   is trusted, every key must be one of its keys; a mismatch is tolerated
//   for mismatchMs, then the Map is dropped;
// - with no tile at all, the Map is kept only while an anchor model lives.
export function createMembershipTracker({ mismatchMs = MISMATCH_MS, entriesPerTick = ENTRIES_PER_TICK } = {}) {
  let map = null
  let validated = new Set()
  let complete = false
  let mismatchSince = null
  let anchors = []
  let lastScan = -Infinity
  let lastSize = -1
  let scanOk = true

  function drop() { map = null; validated = new Set(); complete = false; mismatchSince = null; anchors = []; lastScan = -Infinity; lastSize = -1; scanOk = true }

  function adopt(candidate, tileModels) {
    drop()
    map = candidate
    anchors = tileModels.slice(0, 64)
  }

  // result: walk result; ids: tile ids the walk required the Map to cover.
  function finish({ state, members, reached }, ids, tileModels, isParticipantModel) {
    if (state !== 'complete') return drop()
    if (!ids.length) { if (map && !reached.has(map)) drop(); return }
    const found = isParticipantModel ? members.filter(candidate => passesDiscovery(candidate, ids, isParticipantModel)) : []
    if (found.length !== 1) return drop()
    if (found[0] !== map) adopt(found[0], tileModels)
  }

  // O(size): validates new keys (bounded per tick) and checks level subset.
  function scan(now, levelValues, isParticipantModel) {
    const keys = readKeys(map)
    if (!keys) return false
    const current = new Set(keys)
    for (const id of validated) if (!current.has(id)) validated.delete(id)
    if (isParticipantModel) {
      let checked = 0
      for (const id of keys) {
        if (validated.has(id)) continue
        if (checked++ >= entriesPerTick) break
        if (!validEntry(map, id, isParticipantModel)) return false
        validated.add(id)
      }
    }
    complete = validated.size === current.size
    lastScan = now
    lastSize = current.size
    scanOk = !levelValues || keys.every(id => levelValues.has(id))
    return true
  }

  function update({ now, tileIds, levelValues, tileModels, isParticipantModel }) {
    if (!map) return
    let size = -1
    try { size = mapSize.call(map) } catch {}
    if (size !== lastSize || !complete || now - lastScan >= FULL_SCAN_MS) {
      if (!scan(now, levelValues, isParticipantModel)) return drop()
    }
    let covered = false
    try { covered = tileIds.every(id => mapHas.call(map, id)) } catch {}
    const consistent = covered && scanOk
    if (consistent) {
      mismatchSince = null
      if (tileModels.length) anchors = [...new Set([...tileModels, ...anchors.filter(isLive)])].slice(0, 64)
    } else {
      mismatchSince ??= now
      if (now - mismatchSince > mismatchMs) return drop()
    }
    if (!tileIds.length && !tileModels.length && !anchors.some(isLive)) drop()
  }

  return {
    finish,
    update,
    reset: drop,
    get map() { return map },
    get anchors() { return anchors.filter(isLive) },
    get trusted() { return Boolean(map && complete) },
    // Boolean membership answer only; never exposes the key set.
    has(id) {
      if (!map || !complete || typeof id !== 'string') return false
      try { return mapHas.call(map, id) } catch { return false }
    }
  }
}
