// Meet keeps a participant-keyed registry of audio-activity levels (values in
// [0, 5], the integer part being the ring's fifths) that covers EVERY
// participant, including people whose tile Meet is not rendering (someone is
// presenting, large meetings). Tile activity models only exist for rendered
// tiles, so this registry is the tile-independent source.
//
// Nothing here is keyed to Meet's minified names, which rotate between builds.
// The registry is found structurally: a bounded walk over own DATA properties
// (getters are never invoked) starting from tile activity models that were
// already accepted for their participant, looking for a Map whose keys cover
// every tile-resolved participant id and whose values agree with those
// participants' tile levels. It is trusted only when exactly one such Map
// exists and it has agreed with at least one positive tile level, and it is
// continuously cross-checked against whatever tile models exist each tick.
// Walk cost is bounded per tick by a time budget, not only by object counts.
// The same walk also collects candidates for Meet's membership Map (see
// membership.js), so presence costs no additional walk.

import { createMembershipTracker, isMembershipShaped } from './membership.js'

const MAX_DEPTH = 4
const MAX_OBJECTS = 3000
const MAX_KEYS_PER_OBJECT = 512
// Departed participants stay in Meet's registry, so long large meetings
// accumulate entries; the per-tick copy is O(size) with small constants.
const MAX_MAP_SIZE = 2048
const MAX_VALUE = 5.5
const MAX_ANCHORS = 64
const MAX_CANDIDATES = 64
const DISCOVERY_MS = 1000
const VERIFY_MS = 5000
const MISMATCH_MS = 1000
// A walk runs in slices of SLICE_MS on consecutive ticks; one that has not
// finished after MAX_SLICES is abandoned and yields no candidate.
const SLICE_MS = 4
const MAX_SLICES = 5
const CLOCK_EVERY = 64

const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get
const mapEntries = Map.prototype.entries
const mapHas = Map.prototype.has
const monotonic = typeof globalThis.performance?.now === 'function' ? () => globalThis.performance.now() : () => Date.now()
// Objects with more than MAX_KEYS_PER_OBJECT enumerable keys are collections,
// not service holders: they are never descended, and remembered so their key
// list (which the engine materialises in full) is only built once.
const wideObjects = new WeakSet()

function isMap(value) {
  try { return value instanceof Map && Number.isInteger(mapSize.call(value)) } catch { return false }
}

function isSkipped(value) {
  try {
    if (value === globalThis || ArrayBuffer.isView(value)) return true
    return typeof Node === 'function' && value instanceof Node
  } catch { return true }
}

// Copy of the registry when it still satisfies the level-registry invariant
// (string keys, finite values in [0, 5.5], bounded size); otherwise null.
export function readLevelRegistry(map) {
  try {
    const size = mapSize.call(map)
    if (!(size >= 1 && size <= MAX_MAP_SIZE)) return null
    const values = new Map()
    for (const [key, value] of mapEntries.call(map)) {
      if (typeof key !== 'string' || !key || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_VALUE) return null
      values.set(key, value)
      if (values.size > MAX_MAP_SIZE) return null
    }
    return values
  } catch { return null }
}

// Meet's ring shows Math.round(level * 5) > 0 with level = floor(value) / 5.
export function registryStep(value) { return Math.floor(value) }

// tileLevels: participant id -> tile model level (0..1) read this tick.
export function compareWithTiles(values, tileLevels) {
  let positive = false
  for (const [id, level] of tileLevels) {
    const value = values.get(id)
    const step = Math.round(level * 5)
    if (value === undefined || registryStep(value) !== step) return { ok: false, positive: false }
    if (step > 0) positive = true
  }
  return { ok: tileLevels.size > 0, positive }
}

// Own data values without listing every key: arrays by index up to the cap
// (length read from its descriptor), other objects by a for-in stopped at the
// cap. Getters are never invoked. Returns [] for wide or unreadable objects.
function ownDataValues(object) {
  const values = []
  const push = key => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      if (descriptor && 'value' in descriptor) values.push(descriptor.value)
    } catch {}
  }
  try {
    if (wideObjects.has(object)) return values
    if (Array.isArray(object)) {
      const length = Object.getOwnPropertyDescriptor(object, 'length')?.value
      const count = Number.isInteger(length) ? Math.min(length, MAX_KEYS_PER_OBJECT) : 0
      for (let index = 0; index < count; index++) push(index)
      return values
    }
    const names = []
    for (const name in object) {
      if (names.length >= MAX_KEYS_PER_OBJECT) { wideObjects.add(object); return values }
      names.push(name)
    }
    for (const name of names) push(name)
  } catch {}
  return values
}

function coversIds(map, ids) {
  try { return ids.every(id => mapHas.call(map, id)) } catch { return false }
}

// Resumable, time-budgeted walk over own data properties from the anchors.
// Collects distinct Maps whose keys cover `ids` and that satisfy the value
// invariant (values are compared with tiles by the caller when it finishes),
// distinct membership-shaped Maps covering `ids`, and which `targets` were
// reached. step() returns 'running', 'complete' or 'incomplete' (time budget
// or candidate cap exhausted).
export function createRegistryWalk({ anchors, ids = [], target = null, targets = [target], clock = monotonic, sliceMs = SLICE_MS, maxSlices = MAX_SLICES }) {
  const visited = new Set(anchors)
  const queue = anchors.map(anchor => [anchor, 0])
  const candidates = new Set()
  const members = new Set()
  const wanted = new Set(targets.filter(Boolean))
  const reached = new Set()
  let head = 0
  let pending = null
  let index = 0
  let depth = 0
  let slices = 0
  let state = 'running'

  function visit(value) {
    if (value === null || typeof value !== 'object' || visited.has(value)) return 1
    if (visited.size >= MAX_OBJECTS) { state = 'complete'; return 0 }
    visited.add(value)
    if (wanted.has(value)) reached.add(value)
    if (isSkipped(value)) return 1
    if (isMap(value)) {
      if (!ids.length || !coversIds(value, ids)) return 1 + ids.length
      if (readLevelRegistry(value)) candidates.add(value)
      else if (isMembershipShaped(value)) members.add(value)
      else return 1 + mapSize.call(value)
      if (candidates.size > MAX_CANDIDATES || members.size > MAX_CANDIDATES) state = 'incomplete'
      return mapSize.call(value)
    }
    if (depth + 1 < MAX_DEPTH) queue.push([value, depth + 1])
    return 1
  }

  function step() {
    if (state !== 'running') return state
    slices++
    const start = clock()
    let work = 0
    while (state === 'running') {
      if (work >= CLOCK_EVERY) {
        work = 0
        if (clock() - start >= sliceMs) {
          if (slices >= maxSlices) state = 'incomplete'
          break
        }
      }
      if (pending && index < pending.length) { work += visit(pending[index++]); continue }
      if (head >= queue.length) { state = 'complete'; break }
      const [object, objectDepth] = queue[head++]
      pending = ownDataValues(object)
      index = 0
      depth = objectDepth
      // Listing keys is the expensive part (a first-sight wide object lists
      // them all), so the clock is checked after every object.
      work = CLOCK_EVERY
    }
    return state
  }

  return { step, result: () => ({ state, candidates: [...candidates], members: [...members], reached, reachedTarget: reached.has(target) }) }
}

function isLive(model) {
  try { return model.isDisposed() === false } catch { return false }
}

function agreeing(candidates, tileLevels) {
  return candidates.filter(candidate => {
    const values = readLevelRegistry(candidate)
    return values && compareWithTiles(values, tileLevels).ok
  })
}

// Trust rules (documented policy):
// - discovery starts at most once per discoveryMs while not trusted; its walk
//   is time-budgeted and runs in slices over a few ticks. It must finish and
//   find exactly one Map agreeing with the tiles of the tick it finishes on
//   (an unfinished walk yields nothing; an untrusted candidate is re-checked);
// - a candidate becomes trusted after a tick where every tile-resolved
//   participant agrees and at least one of them has a positive level;
// - every tick with tile participants is a validation: disagreement (or a
//   tile participant missing from the Map) is tolerated for mismatchMs
//   (read timing), then trust is dropped and the Map is rediscovered. The
//   local tile's level is part of that validation when its id is in the Map;
// - while trusted, the walk re-runs every verifyMs: trust is dropped when it
//   does not finish, when the Map is no longer reachable from the anchors
//   (Meet replaced it; a single agreeing replacement becomes a candidate under
//   the rules above) or when another Map agrees with a positive tile level;
// - models that agreed with the Map are its anchors; with no tile participant
//   at all the Map is kept only while one anchor is not disposed;
// - a Map that stops satisfying the value invariant is dropped immediately;
// - while no membership Map is held, walks also run at most once per
//   discoveryMs (a trusted level Map is then re-verified by them); every
//   finished walk is also a membership re-validation (membership.js).
export function createActivityRegistry({ discoveryMs = DISCOVERY_MS, mismatchMs = MISMATCH_MS, verifyMs = VERIFY_MS, clock = monotonic } = {}) {
  const membership = createMembershipTracker({ mismatchMs })
  let map = null
  let trusted = false
  let anchors = []
  let mismatchSince = null
  let lastDiscovery = -Infinity
  let lastVerify = -Infinity
  let walk = null

  function drop() { map = null; trusted = false; anchors = []; mismatchSince = null }

  function adopt(models) {
    anchors = [...new Set([...models, ...anchors.filter(isLive)])].slice(0, MAX_ANCHORS)
  }

  function trust(now) { if (!trusted) lastVerify = now; trusted = true }

  function adoptUnique(found, now, tileLevels, tileModels) {
    drop()
    if (found.length !== 1) return
    map = found[0]
    anchors = tileModels.slice(0, MAX_ANCHORS)
    const values = readLevelRegistry(map)
    if (values && compareWithTiles(values, tileLevels).positive) trust(now)
  }

  function finish({ purpose, target, run, ids }, now, tileLevels, tileModels, isParticipantModel) {
    const result = run.result()
    membership.finish(result, ids, tileModels, isParticipantModel)
    if (purpose === 'members') return
    const { state, candidates, reachedTarget } = result
    const found = state === 'complete' && tileLevels.size ? agreeing(candidates, tileLevels) : []
    if (purpose === 'discover') {
      // A candidate trusted while the walk ran keeps its trust if still unique.
      if (!(trusted && found.length === 1 && found[0] === map)) adoptUnique(found, now, tileLevels, tileModels)
      return
    }
    // Trust was dropped meanwhile: normal discovery takes over.
    if (map !== target) return
    if (state !== 'complete' || !reachedTarget) return adoptUnique(found, now, tileLevels, tileModels)
    const values = readLevelRegistry(map)
    if (found.length > 1 && values && compareWithTiles(values, tileLevels).positive) drop()
  }

  // selfLevels: local participant id -> local tile level, a cross-check only.
  // isParticipantModel(value, id): the tile path's identity check (null while
  // no activity getter is known). Returns the trusted registry values for
  // this tick, or null.
  function update({ now, tileLevels, tileModels, selfLevels = new Map(), isParticipantModel = null }) {
    let values = map ? readLevelRegistry(map) : null
    if (map && !values) drop()
    const checked = map
    if (map) {
      const self = new Map([...selfLevels].filter(([id]) => values.has(id)))
      if (tileLevels.size || self.size) {
        const check = tileLevels.size ? compareWithTiles(values, tileLevels) : { ok: true, positive: false }
        if (check.ok && (!self.size || compareWithTiles(values, self).ok)) {
          mismatchSince = null
          if (check.positive) trust(now)
          adopt(tileModels)
        } else {
          mismatchSince ??= now
          if (now - mismatchSince > mismatchMs) drop()
        }
      } else if (!anchors.some(isLive)) drop()
    }
    // An untrusted candidate is re-checked by discovery too, so a second
    // agreeing Map appearing later makes the choice ambiguous again.
    const ids = [...tileLevels.keys()]
    const discovering = (!trusted || !membership.map) && ids.length && tileModels.length && now - lastDiscovery >= discoveryMs
    if (!walk && (discovering || ((trusted || membership.map) && now - lastVerify >= verifyMs))) {
      const verify = Boolean(map && trusted)
      if (discovering) lastDiscovery = now
      if (verify || !discovering) lastVerify = now
      const roots = discovering && !verify ? tileModels : [...new Set([...tileModels, ...anchors.filter(isLive), ...membership.anchors])]
      const target = verify ? map : null
      // 'members': only the membership Map is re-validated by this walk.
      walk = { purpose: verify ? 'verify' : discovering ? 'discover' : 'members', target, ids, run: createRegistryWalk({ anchors: roots, ids, target, targets: [target, membership.map], clock }) }
    }
    if (walk && walk.run.step() !== 'running') {
      const finished = walk
      walk = null
      finish(finished, now, tileLevels, tileModels, isParticipantModel)
    }
    // One O(size) copy per tick unless a walk switched to another Map.
    if (map !== checked) values = map ? readLevelRegistry(map) : null
    const levelValues = map && trusted ? values : null
    membership.update({ now, tileIds: ids, levelValues, tileModels, isParticipantModel })
    // While the registry disagrees with the rendered tiles (tolerated for
    // mismatchMs before trust is dropped), do not route from it: the caller
    // falls back to the tile path, which reports tileless participants as
    // unknown, so output goes to unity instead of holding a possibly wrong boost.
    return mismatchSince === null ? levelValues : null
  }

  return {
    update,
    reset: () => { drop(); membership.reset(); walk = null; lastDiscovery = -Infinity; lastVerify = -Infinity },
    get trusted() { return Boolean(map && trusted) },
    membership
  }
}

// Maps registry ids onto every known participant (present or not). Self ids
// are ignored. A speaking id that belongs to nobody known is only counted:
// its gain is unknown, so routing must stay at unity.
export function readRegistryActivity(values, participants, known, selfIds) {
  const byId = new Map()
  for (const participant of [...known, ...participants]) {
    if (participant?.participantId && !selfIds.has(participant.participantId)) byId.set(participant.participantId, participant)
  }
  const levels = new Map()
  const speakers = []
  let unknownSpeakers = 0
  for (const [id, value] of values) {
    if (selfIds.has(id)) continue
    const participant = byId.get(id)
    const step = registryStep(value)
    if (participant) {
      levels.set(participant.key, step / 5)
      if (step >= 1) speakers.push(participant)
    } else if (step >= 1) unknownSpeakers++
  }
  // A present participant absent from the registry could be the one speaking.
  const unknown = participants.filter(participant => !levels.has(participant.key)).map(participant => participant.key)
  return { available: unknown.length === 0, levels, unknown, speakers, unknownSpeakers, source: 'meet-registry' }
}
