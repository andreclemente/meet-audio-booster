import { readAudioParam, writeAudioParam } from '../../shared/audio.js'

function normalizeIndex(value) {
  return value === undefined ? 0 : value
}

function connectionMatches(mapping, args) {
  if (!args.length) return true
  if (typeof args[0] === 'number') return mapping.output === args[0]
  if (args[0] !== mapping.destination) return false
  if (args.length > 1 && mapping.output !== normalizeIndex(args[1])) return false
  if (args.length > 2 && mapping.input !== normalizeIndex(args[2])) return false
  return true
}

export function installAudioWorkletHook(onSlot, onRemove = () => {}) {
  if (!globalThis.AudioNode || globalThis.__meetingAudioBoosterWorkletHook) return () => {}
  const originalConnect = AudioNode.prototype.connect
  const originalDisconnect = AudioNode.prototype.disconnect
  const mappings = []
  let disposed = false

  const connectWrapper = function (...args) {
    if (disposed) return originalConnect.apply(this, args)
    const destination = args[0]
    const isPooledConnection = this?.constructor?.name === 'AudioWorkletNode' && destination?.constructor?.name === 'GainNode'
    if (!isPooledConnection || typeof destination?.context?.createGain !== 'function') return originalConnect.apply(this, args)
    const output = normalizeIndex(args[1])
    const input = normalizeIndex(args[2])
    const existing = mappings.find(item => item.source === this && item.destination === destination && item.output === output && item.input === input)
    if (existing) return destination

    // Native connect is idempotent for an identical edge. Remove any edge
    // created before this hook so replacing it cannot produce a parallel path.
    let removedDirect = false
    try {
      originalDisconnect.call(this, destination, output, input)
      removedDirect = true
    } catch (error) {
      if (error?.name !== 'InvalidAccessError') throw error
    }
    let booster
    let sourceConnected = false
    try {
      booster = destination.context.createGain()
      booster.gain.value = 1
      const sourceArgs = args.length > 1 ? [booster, args[1]] : [booster]
      const destinationArgs = args.length > 2 ? [destination, 0, args[2]] : [destination]
      originalConnect.apply(this, sourceArgs)
      sourceConnected = true
      originalConnect.apply(booster, destinationArgs)
    } catch (error) {
      if (sourceConnected) {
        try { originalDisconnect.call(this, booster, output, 0) } catch {}
      }
      if (removedDirect) {
        try { originalConnect.apply(this, args) } catch {}
      }
      throw error
    }
    mappings.push({ source: this, destination, booster, output, input, originalArgs: [...args] })
    try { onSlot(booster) } catch {}
    return destination
  }

  const disconnectWrapper = function (...args) {
    if (disposed) return originalDisconnect.apply(this, args)
    const matched = mappings.filter(mapping => mapping.source === this && connectionMatches(mapping, args))
    if (!matched.length) return originalDisconnect.apply(this, args)

    let nativeError = null
    if (!args.length || typeof args[0] === 'number') originalDisconnect.apply(this, args)
    else {
      try { originalDisconnect.apply(this, args) } catch (error) { nativeError = error }
      for (const mapping of matched) {
        try { originalDisconnect.call(this, mapping.booster, mapping.output, 0) } catch {}
      }
    }
    for (const mapping of matched) {
      try { originalDisconnect.call(mapping.booster, mapping.destination, 0, mapping.input) } catch {}
      const index = mappings.indexOf(mapping)
      if (index >= 0) mappings.splice(index, 1)
      try { onRemove(mapping.booster) } catch {}
    }
    if (nativeError && nativeError.name !== 'InvalidAccessError') throw nativeError
  }

  AudioNode.prototype.connect = connectWrapper
  AudioNode.prototype.disconnect = disconnectWrapper
  globalThis.__meetingAudioBoosterWorkletHook = { originalConnect, originalDisconnect }

  return () => {
    if (disposed) return
    disposed = true
    for (const mapping of [...mappings]) {
      // The direct route is connected before the owned route is removed. Make
      // that synchronous overlap neutral even if the slot was boosted.
      try { writeAudioParam(mapping.booster.gain, 1) } catch {}
      let restored = false
      try {
        originalConnect.apply(mapping.source, mapping.originalArgs)
        restored = true
      } catch {}
      if (restored) {
        try { originalDisconnect.call(mapping.source, mapping.booster, mapping.output, 0) } catch {}
        try { originalDisconnect.call(mapping.booster, mapping.destination, 0, mapping.input) } catch {}
        try { onRemove(mapping.booster) } catch {}
      }
    }
    mappings.length = 0
    if (AudioNode.prototype.connect === connectWrapper) AudioNode.prototype.connect = originalConnect
    if (AudioNode.prototype.disconnect === disconnectWrapper) AudioNode.prototype.disconnect = originalDisconnect
    delete globalThis.__meetingAudioBoosterWorkletHook
  }
}

export function createPooledSlot(gain, id) {
  const baseGain = readAudioParam(gain.gain)
  return {
    id,
    gain,
    baseGain,
    nativeValue: baseGain,
    appliedMultiplier: 1,
    targetValue: baseGain,
    participantKey: null,
    get actualValue() { return readAudioParam(gain.gain) },
    set(multiplier) {
      const safe = Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1
      if (safe === this.appliedMultiplier) return
      writeAudioParam(gain.gain, safe)
      this.appliedMultiplier = safe
      this.targetValue = safe
      this.participantKey = null
    },
    release() {
      if (this.appliedMultiplier === 1) return
      writeAudioParam(gain.gain, 1)
      this.appliedMultiplier = 1
      this.targetValue = 1
      this.participantKey = null
    },
    neutral() { this.release() },
    destroy() { this.release() }
  }
}
