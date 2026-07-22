import { readAudioParam, writeAudioParam } from '../../shared/audio.js'

export function installAudioWorkletHook(onSlot) {
  if (!globalThis.AudioNode || globalThis.__meetingAudioBoosterWorkletHook) return () => {}
  const originalConnect = AudioNode.prototype.connect
  const originalDisconnect = AudioNode.prototype.disconnect
  const routes = new WeakMap()
  const liveRoutes = new Set()
  let active = true

  function normalizePort(value) {
    return value === undefined ? 0 : Number(value) >>> 0
  }

  function isAudioDestination(value) {
    try {
      if (globalThis.AudioNode && value instanceof globalThis.AudioNode) return true
      if (globalThis.AudioParam && value instanceof globalThis.AudioParam) return true
    } catch {}
    return false
  }

  function sourceRoutes(source) {
    let byDestination = routes.get(source)
    if (!byDestination) {
      byDestination = new Map()
      routes.set(source, byDestination)
    }
    return byDestination
  }

  function removeRecord(route) {
    route.dispose?.()
    liveRoutes.delete(route)
    const byDestination = routes.get(route.source)
    const destinationRoutes = byDestination?.get(route.destination)
    destinationRoutes?.delete(route.key)
    if (destinationRoutes && !destinationRoutes.size) byDestination.delete(route.destination)
    if (byDestination && !byDestination.size) routes.delete(route.source)
  }

  function disconnectOwnedRoute(route, sourceAlreadyDisconnected = false) {
    if (!sourceAlreadyDisconnected) {
      try { originalDisconnect.call(route.source, route.gain, route.output, 0) } catch {}
    }
    try { originalDisconnect.call(route.gain, route.destination, 0, route.input) } catch {}
    removeRecord(route)
  }

  function restoreNativeRoute(route) {
    try { originalDisconnect.call(route.source, route.gain, route.output, 0) } catch {}
    let restored = false
    try {
      originalConnect.call(route.source, route.destination, route.output, route.input)
      restored = true
    } catch {}
    if (restored) {
      try { originalDisconnect.call(route.gain, route.destination, 0, route.input) } catch {}
    } else {
      try { originalConnect.call(route.source, route.gain, route.output, 0) } catch {}
    }
    removeRecord(route)
  }

  const connectWrapper = function (...args) {
    if (!active) return originalConnect.apply(this, args)
    const source = this
    const destination = args[0]
    const isPooledRoute = source?.constructor?.name === 'AudioWorkletNode' && destination?.constructor?.name === 'GainNode'
    if (!isPooledRoute) return originalConnect.apply(source, args)

    let output, input
    try {
      output = normalizePort(args.length > 1 ? args[1] : 0)
      input = normalizePort(args.length > 2 ? args[2] : 0)
    } catch {
      return originalConnect.apply(source, args)
    }
    const key = `${output}:${input}`
    const byDestination = sourceRoutes(source)
    let destinationRoutes = byDestination.get(destination)
    if (!destinationRoutes) {
      destinationRoutes = new Map()
      byDestination.set(destination, destinationRoutes)
    }
    if (destinationRoutes.has(key)) return destination

    let gain
    try {
      gain = source.context?.createGain?.()
      if (!gain) return originalConnect.apply(source, args)
      originalConnect.call(source, gain, output, 0)
      originalConnect.call(gain, destination, 0, input)
    } catch {
      if (gain) {
        try { originalDisconnect.call(source, gain, output, 0) } catch {}
        try { originalDisconnect.call(gain, destination, 0, input) } catch {}
      }
      return originalConnect.apply(source, args)
    }

    const route = { source, destination, gain, output, input, key, dispose: null }
    destinationRoutes.set(key, route)
    liveRoutes.add(route)
    try { route.dispose = onSlot(gain) || null } catch (error) { console.warn('[Meet Audio Booster] Could not register worklet slot', error) }
    return destination
  }

  const disconnectWrapper = function (...args) {
    if (!active) return originalDisconnect.apply(this, args)
    const source = this
    const byDestination = routes.get(source)
    if (!byDestination?.size) return originalDisconnect.apply(source, args)

    if (!args.length) {
      originalDisconnect.apply(source, args)
      const owned = [...liveRoutes].filter(route => route.source === source)
      for (const route of owned) disconnectOwnedRoute(route, true)
      return undefined
    }

    if (args.length === 1 && !isAudioDestination(args[0])) {
      originalDisconnect.apply(source, args)
      const output = normalizePort(args[0])
      const owned = [...liveRoutes].filter(route => route.source === source && route.output === output)
      for (const route of owned) disconnectOwnedRoute(route, true)
      return undefined
    }

    const destination = args[0]
    const destinationRoutes = byDestination.get(destination)
    if (!destinationRoutes?.size) return originalDisconnect.apply(source, args)
    let output, input
    try {
      output = args.length > 1 ? normalizePort(args[1]) : null
      input = args.length > 2 ? normalizePort(args[2]) : null
    } catch {
      return originalDisconnect.apply(source, args)
    }
    const matched = [...destinationRoutes.values()].filter(route => {
      if (output !== null && route.output !== output) return false
      return input === null || route.input === input
    })
    if (!matched.length) return originalDisconnect.apply(source, args)
    for (const route of matched) disconnectOwnedRoute(route)
    return undefined
  }

  const marker = { originalConnect, originalDisconnect }
  globalThis.__meetingAudioBoosterWorkletHook = marker
  AudioNode.prototype.connect = connectWrapper
  AudioNode.prototype.disconnect = disconnectWrapper
  return () => {
    active = false
    for (const route of [...liveRoutes]) restoreNativeRoute(route)
    if (AudioNode.prototype.connect === connectWrapper) AudioNode.prototype.connect = originalConnect
    if (AudioNode.prototype.disconnect === disconnectWrapper) AudioNode.prototype.disconnect = originalDisconnect
    if (globalThis.__meetingAudioBoosterWorkletHook === marker) delete globalThis.__meetingAudioBoosterWorkletHook
  }
}

export function createPooledSlot(gain, id) {
  const baseGain = readAudioParam(gain.gain)
  return {
    id, gain, baseGain, appliedMultiplier: 1, targetValue: baseGain, lastWriteAt: 0,
    // A pooled slot is deliberately never assigned a participant identity.
    participantKey: null,
    set(multiplier, immediate = false) {
      const safe = Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1
      const target = baseGain * safe
      const actual = Number(gain?.gain?.value)
      const now = performance.now()
      this.appliedMultiplier = safe
      this.targetValue = target
      this.participantKey = null
      // Neutral transitions are written once. Repeating the same write on every
      // routing tick adds no value and can interfere with other graph wrappers.
      if (!immediate && safe === 1) return
      if (!immediate && Number.isFinite(actual) && Math.abs(actual - target) <= 0.002 && now - this.lastWriteAt < 90) return
      writeAudioParam(gain.gain, target)
      this.lastWriteAt = now
    },
    neutral(immediate = true) { this.set(1, immediate) }
  }
}
