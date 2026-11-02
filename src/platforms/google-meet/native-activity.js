// Meet renders its "speaking" ring from a per-participant audio-activity model
// that keeps updating while the tab is hidden (unlike the ring itself, whose
// rendering is throttled). This module reads that model, read-only.
//
// Meet's minified names change between builds, so nothing here is keyed to a
// minified name. The activity getter is located by parsing Meet's own ring
// renderer (`Math.round(<model>.<getter>()*5)`), and source models are only
// accepted when one of their delegating getters returns exactly the
// participant's data-participant-id and the model is not disposed. Anything
// that cannot be confirmed is reported as unknown, never guessed.

const RING_RENDERER = /Math\.round\([^;]*?\.([A-Za-z_$][\w$]*)\(\)\*5\)/
const DELEGATING_GETTER = /^[A-Za-z_$][\w$]*\(\)\{return this\.[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(\)\}$/
const MAX_ELEMENTS_PER_ROOT = 256
const MAX_MODELS_PER_ROOT = 16
const REDISCOVER_MS = 1000
const GETTER_RETRY_MS = 1000
const GETTER_STALE_MS = 10000

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    !(typeof Node === 'function' && value instanceof Node) && typeof value.nodeType !== 'number'
}

function ownMethods(object, depth = 2) {
  const methods = []
  let proto = Object.getPrototypeOf(object)
  for (let level = 0; level < depth && proto && proto !== Object.prototype; level++, proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name)
      if (typeof descriptor?.value === 'function') methods.push([name, descriptor.value])
    }
  }
  return methods
}

function sourceOf(fn) {
  try { return Function.prototype.toString.call(fn) } catch { return '' }
}

function elementsOf(root, selector) {
  const nested = [...(root?.querySelectorAll?.(selector) || [])]
  return [root, ...nested].slice(0, MAX_ELEMENTS_PER_ROOT)
}

function holdersOf(element) {
  const holders = []
  const models = element?.__jsmodel
  if (isObject(models)) for (const entry of Object.values(models)) holders.push(entry?.pending?.value)
  holders.push(element?.__jscontroller?.pending?.value)
  return holders.filter(isObject)
}

export function findActivityGetterName(root) {
  let elements = []
  try { elements = elementsOf(root, '[jscontroller]') } catch { return null }
  for (const element of elements) {
    // One unreadable controller must not hide the ring renderer after it.
    try {
      const controller = element?.__jscontroller?.pending?.value
      if (!isObject(controller)) continue
      for (const [name, fn] of ownMethods(controller)) {
        // A class constructor's source is the whole class body, including
        // methods that may since have been replaced.
        if (name === 'constructor') continue
        const source = sourceOf(fn)
        const match = source.match(RING_RENDERER)
        if (match && />\s*0/.test(source.slice(match.index))) return match[1]
      }
    } catch {}
  }
  return null
}

export function isParticipantSourceModel(value, participantId, activityGetter, identityCache = new WeakMap()) {
  // Meet's objects are foreign: any property read may throw, so every failure
  // means "not confirmed" rather than propagating into the routing loop.
  try {
    if (!isObject(value) || typeof value.isDisposed !== 'function' || typeof value[activityGetter] !== 'function') return false
    const proto = Object.getPrototypeOf(value)
    if (!proto || proto === Object.prototype) return false
    let candidates = identityCache.get(proto)
    if (!candidates) {
      // Only a class whose activity getter is itself a plain delegating read
      // has the source-model shape; never call getters on other objects.
      const shaped = DELEGATING_GETTER.test(sourceOf(proto[activityGetter]))
      candidates = shaped ? ownMethods(value, 1)
        .filter(([name, fn]) => name !== activityGetter && fn.length === 0 && DELEGATING_GETTER.test(sourceOf(fn)))
        .map(([name]) => name) : []
      identityCache.set(proto, candidates)
    }
    if (!candidates.length || value.isDisposed()) return false
    // Which getter carries the participant id differs between representations
    // (e.g. the local tile reuses it as its media id), so test every candidate.
    for (const name of candidates) {
      try { if (value[name]() === participantId) return true } catch {}
    }
  } catch {}
  return false
}

function valuesOf(object) {
  try { return Object.values(object) } catch { return [] }
}

export function discoverParticipantSourceModels(root, participantId, activityGetter, identityCache) {
  const found = []
  const seen = new Set()
  const consider = value => {
    let object = false
    try { object = isObject(value) } catch {}
    if (!object || seen.has(value)) return false
    seen.add(value)
    if (!isParticipantSourceModel(value, participantId, activityGetter, identityCache)) return false
    found.push(value)
    return true
  }
  for (const element of elementsOf(root, '[jsmodel],[jscontroller]')) {
    let holders = []
    try { holders = holdersOf(element) } catch {}
    for (const holder of holders) {
      for (const value of valuesOf(holder)) {
        if (found.length >= MAX_MODELS_PER_ROOT) return found
        if (consider(value) || !seen.has(value)) continue
        // Controllers hold models one level deeper (e.g. a view-model holder).
        for (const nested of valuesOf(value)) {
          if (found.length >= MAX_MODELS_PER_ROOT) return found
          consider(nested)
        }
      }
    }
  }
  return found
}

// Models passed here were validated for this participant during this read.
function readLevel(model, getter) {
  try {
    const level = model[getter]()
    return typeof level === 'number' && Number.isFinite(level) && level >= 0 && level <= 1 ? level : null
  } catch { return null }
}

// Meet's ring is shown when Math.round(level * 5) > 0.
export function isSpeakingLevel(level) {
  return Number.isFinite(level) && Math.round(level * 5) > 0
}

export function createNativeActivitySource({ rediscoverMs = REDISCOVER_MS } = {}) {
  let getter = null
  let lastGetterAttempt = -Infinity
  let lastConfirmedAt = 0
  // Identity candidates depend on the activity getter, so the cache is
  // replaced whenever the getter is rediscovered.
  let identityCache = new WeakMap()
  const entries = new Map()

  function rootsFor(participant, rootsByParticipantId) {
    const roots = rootsByParticipantId.get(participant.participantId) || []
    if (participant.element && !roots.includes(participant.element)) roots.push(participant.element)
    return roots.filter(root => root && root.isConnected !== false)
  }

  function modelsFor(participant, roots, now) {
    const cached = entries.get(participant.key)
    const valid = cached?.models.filter(model => isParticipantSourceModel(model, participant.participantId, getter, identityCache))
    // Reuse the last discovery (including an empty one) for a short while, so a
    // participant without a model does not trigger a full search every tick.
    if (cached && cached.participantId === participant.participantId && valid.length === cached.models.length &&
      now - cached.discoveredAt < rediscoverMs) return valid
    const models = []
    for (const root of roots) {
      for (const model of discoverParticipantSourceModels(root, participant.participantId, getter, identityCache)) {
        if (!models.includes(model)) models.push(model)
      }
    }
    entries.set(participant.key, { participantId: participant.participantId, models, discoveredAt: now })
    return models
  }

  function readUnsafe(participants, root, now) {
    const rootsByParticipantId = new Map()
    for (const element of root?.querySelectorAll?.('[data-participant-id]') || []) {
      const id = element.getAttribute?.('data-participant-id')
      if (!id) continue
      if (!rootsByParticipantId.has(id)) rootsByParticipantId.set(id, [])
      rootsByParticipantId.get(id).push(element)
    }
    if (getter && participants.length && now - lastConfirmedAt > GETTER_STALE_MS) {
      // A getter that has not confirmed anyone for a long time may be a wrong
      // match from an unrelated renderer: rediscover rather than stay dead.
      getter = null
      entries.clear()
      identityCache = new WeakMap()
    }
    if (!getter && now - lastGetterAttempt >= GETTER_RETRY_MS) {
      lastGetterAttempt = now
      for (const roots of rootsByParticipantId.values()) {
        for (const candidate of roots) { getter = findActivityGetterName(candidate); if (getter) break }
        if (getter) break
      }
      if (getter) lastConfirmedAt = now
    }
    const levels = new Map()
    const unknown = []
    for (const key of entries.keys()) if (!participants.some(participant => participant.key === key)) entries.delete(key)
    if (!getter) return { available: false, levels, unknown: participants.map(participant => participant.key), speakers: [] }
    for (const participant of participants) {
      const roots = rootsFor(participant, rootsByParticipantId)
      const models = roots.length ? modelsFor(participant, roots, now) : []
      // Meet may keep several representations of one participant and zero all
      // but one, so the strongest current representation is the activity.
      let level = null
      for (const model of models) {
        const value = readLevel(model, getter)
        if (value !== null) level = Math.max(level ?? 0, value)
      }
      if (level === null) { unknown.push(participant.key); continue }
      levels.set(participant.key, level)
    }
    const speakers = participants.filter(participant => isSpeakingLevel(levels.get(participant.key)))
    if (levels.size) lastConfirmedAt = now
    // Routing is only safe when every present participant's activity is known:
    // an unconfirmed participant could be the one actually speaking.
    return { available: participants.length > 0 && unknown.length === 0, levels, unknown, speakers }
  }

  function read(participants, root = globalThis.document, now = Date.now()) {
    try {
      return readUnsafe(participants, root, now)
    } catch {
      return { available: false, levels: new Map(), unknown: participants.map(participant => participant.key), speakers: [] }
    }
  }

  function reset() { entries.clear() }

  return { read, reset, get activityGetter() { return getter } }
}
