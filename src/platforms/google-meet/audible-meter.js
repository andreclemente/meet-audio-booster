import { meanSquare } from './levels.js'

// Observed hardware-playback contract, not a claim to enumerate the page heap.
// Only gain-only remote branches are supported. The private sum has no output
// route: notifications into the hardware destination never enter this meter.
export function createAudibleMeter({ mappings, connect, disconnect }) {
  const edges = [], automated = new WeakSet()
  let revision = 0, overflow = false, probe = null, stable = null, nativeSignature = null, contractActive = false
  // An opaque coordinate-system epoch. Only a positive static native-gain
  // change may retain it; an unsafe intermediate transition cannot be bridged.
  let continuity = {}, reason = 'unverified', ownership = [], positiveNative = false
  const type = node => node?.constructor?.name
  const restores = [], newSources = new WeakSet(), newGains = new WeakSet()
  const Gain = globalThis.GainNode
  if (typeof Gain === 'function') {
    const wrapper = new Proxy(Gain, { construct(target, args, newTarget) {
      const node = Reflect.construct(target, args, newTarget); newGains.add(node); return node
    } })
    try { globalThis.GainNode = wrapper; restores.push(() => { if (globalThis.GainNode === wrapper) globalThis.GainNode = Gain }) } catch { overflow = true }
  }
  const Worklet = globalThis.AudioWorkletNode
  if (typeof Worklet === 'function') {
    const wrapper = new Proxy(Worklet, { construct(target, args, newTarget) {
      const node = Reflect.construct(target, args, newTarget); newSources.add(node); return node
    } })
    try { globalThis.AudioWorkletNode = wrapper; restores.push(() => { if (globalThis.AudioWorkletNode === wrapper) globalThis.AudioWorkletNode = Worklet }) } catch { overflow = true }
  }
  for (const Context of [globalThis.BaseAudioContext, globalThis.AudioContext, globalThis.OfflineAudioContext]) {
    const proto = Context?.prototype
    if (!proto || !Object.hasOwn(proto, 'createGain')) continue
    const original = proto.createGain
    const wrapper = function (...args) { const node = original.apply(this, args); newGains.add(node); return node }
    try { proto.createGain = wrapper; restores.push(() => { if (proto.createGain === wrapper) proto.createGain = original }) } catch { overflow = true }
  }
  for (const name of ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime', 'setTargetAtTime', 'setValueCurveAtTime']) {
    const proto = globalThis.AudioParam?.prototype, original = proto?.[name]
    if (typeof original !== 'function') continue
    const wrapper = function (...args) { const result = original.apply(this, args); automated.add(this); return result }
    try { proto[name] = wrapper; restores.push(() => { if (proto[name] === wrapper) proto[name] = original }) } catch { overflow = true }
  }
  function clearProbe() {
    if (!probe) return
    for (const node of probe.terminals) { try { disconnect.call(node, probe.bus) } catch {} }
    try { disconnect.call(probe.bus) } catch {}
    try { disconnect.call(probe.splitter) } catch {}
    probe = null
  }
  function changed() { continuity = {}; reason = 'unverified'; revision++; stable = null; clearProbe() }
  function nativeChanged(compatible) {
    if (!compatible) { changed(); return }
    revision++; reason = 'static-native-gain'; stable = null; clearProbe()
  }
  function unavailable() {
    if (contractActive) { contractActive = false; changed() }
    return NaN
  }
  function connected(source, args) {
    const [destination, output = 0, input = 0] = args
    if (edges.some(e => e.source === source && e.destination === destination && e.output === output && e.input === input)) return
    if (edges.length >= 1024) { overflow = true; changed(); return }
    edges.push({ source, destination, output, input }); changed()
  }
  function disconnected(source, args) {
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i]
      if (e.source !== source) continue
      if (args.length && (typeof args[0] === 'number' ? e.output !== args[0]
        : e.destination !== args[0] || (args.length > 1 && e.output !== args[1]) || (args.length > 2 && e.input !== args[2]))) continue
      edges.splice(i, 1)
    }
    changed()
  }
  function read(slots) {
    const active = mappings()
    if (overflow || !active.length || slots.length !== active.length) return unavailable()
    const context = active[0].booster.context
    if (!context?.createChannelSplitter || active.some(m => m.booster.context !== context)) return unavailable()
    // A video-only MediaStream cannot play audio. Empty media placeholders are
    // equally harmless; inspect again on every read so assigning audio invalidates
    // the contract before another accepted sample. Unknown/file-backed media stays
    // unsupported rather than guessing whether it contains an audible track.
    const document = globalThis.document
    const elements = document?.querySelectorAll
      ? [...document.querySelectorAll('audio,video')]
      : [document?.querySelector?.('audio,video')].filter(Boolean)
    const externalPlayback = elements.some(element => {
      if (typeof element?.getAttribute !== 'function') return true
      const stream = element.srcObject
      if (typeof globalThis.MediaStream === 'function' && stream instanceof globalThis.MediaStream) {
        return stream.getAudioTracks().length !== 0
      }
      return !!(stream || element.currentSrc || element.getAttribute?.('src'))
    })
    if (externalPlayback) return unavailable()
    const gains = new Set(), terminals = new Set(), visiting = new Set()
    let valid = true
    function walk(node) {
      if (visiting.has(node) || type(node) !== 'GainNode' || !newGains.has(node) || node.context !== context || gains.size > 128) { valid = false; return }
      if (gains.has(node)) return
      gains.add(node); visiting.add(node)
      const outgoing = edges.filter(e => e.source === node)
      if (!outgoing.length) valid = false
      for (const e of outgoing) {
        if (e.output !== 0 || e.input !== 0) { valid = false; continue }
        if (e.destination === context.destination) terminals.add(node)
        else if (type(e.destination) === 'GainNode') walk(e.destination)
        else valid = false
      }
      visiting.delete(node)
    }
    for (const m of active) {
      if (m.input !== 0 || !newSources.has(m.source) || m.source.context !== context) valid = false
      walk(m.destination)
      if (edges.some(e => e.destination === m.source)) valid = false
      // A known stream side branch is not a hardware contribution. DOM playback
      // above invalidates this contract; all other source fanouts must be owned.
      for (const e of edges.filter(e => e.source === m.source)) {
        if (!active.some(a => a.source === e.source && a.destination === e.destination && a.output === e.output && a.input === e.input)
          && type(e.destination) !== 'MediaStreamAudioDestinationNode') valid = false
      }
    }
    for (const e of edges) if (gains.has(e.destination) && !gains.has(e.source)
      && !active.some(m => m.source === e.source && m.destination === e.destination && m.output === e.output && m.input === e.input)) valid = false
    const multiplier = slots[0].actualValue
    if (!(multiplier > 0) || slots.some(s => Math.abs(s.actualValue - multiplier) > 0.00001 || Math.abs(s.targetValue - multiplier) > 0.00001)) valid = false
    for (const gain of gains) if (automated.has(gain.gain) || !Number.isFinite(gain.gain.value) || edges.some(e => e.destination === gain.gain)) valid = false
    if (!valid || !terminals.size) { stable = null; clearProbe(); return unavailable() }
    // Channel mixing changes the measured power coordinate system independently
    // of scalar gain. Observe it on every read, before a later native gain can
    // overwrite the reason, and fail closed on missing/invalid/throwing reads.
    const channelContract = []
    for (const node of new Set([context.destination, ...active.map(m => m.source), ...gains])) {
      const { channelCount, channelCountMode, channelInterpretation } = node
      if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 32 ||
        !['max', 'clamped-max', 'explicit'].includes(channelCountMode) ||
        !['speakers', 'discrete'].includes(channelInterpretation)) return unavailable()
      channelContract.push(node, channelCount, channelCountMode, channelInterpretation)
    }
    const nextOwnership = [context, ...channelContract, ...slots,
      ...active.flatMap(m => [m.source, m.destination, m.booster, m.output, m.input]), ...gains, ...terminals]
    if (nextOwnership.length !== ownership.length || nextOwnership.some((v, i) => v !== ownership[i])) {
      ownership = nextOwnership; changed()
    }
    if (!contractActive) { contractActive = true; changed() }
    const nextNative = [...gains].map(g => g.gain.value).join(':')
    const nextPositive = [...gains].every(g => g.gain.value > 0)
    if (nativeSignature !== nextNative) {
      nativeSignature = nextNative; nativeChanged(positiveNative && nextPositive)
    }
    positiveNative = nextPositive
    const signature = [revision, multiplier, nextNative].join(':')
    const now = context.currentTime
    if (!stable || stable.signature !== signature) { stable = { signature, at: now }; return NaN }
    if (now - stable.at < 0.1) return NaN
    if (!probe) {
      try {
        const channels = context.destination.channelCount
        if (!(channels >= 1 && channels <= 8)) return unavailable()
        const bus = context.createGain(), splitter = context.createChannelSplitter(channels)
        bus.channelCount = channels; bus.channelCountMode = 'explicit'
        connect.call(bus, splitter)
        const analysers = Array.from({ length: channels }, (_, i) => {
          const analyser = context.createAnalyser(); analyser.fftSize = 2048
          connect.call(splitter, analyser, i)
          return { analyser, buffer: new Float32Array(2048) }
        })
        probe = { bus, splitter, analysers, terminals: [...terminals], at: now }
        for (const node of terminals) connect.call(node, bus)
      } catch { clearProbe(); return unavailable() }
      return NaN
    }
    if (now - probe.at < 0.1) return NaN
    let power = 0
    for (const { analyser, buffer } of probe.analysers) { analyser.getFloatTimeDomainData(buffer); power += meanSquare(buffer) }
    const normalized = power / (multiplier * multiplier)
    return Number.isFinite(normalized) ? normalized : unavailable()
  }
  return { connected, disconnected, read(slots) {
    try { return read(slots) } catch { return unavailable() }
  }, changed, get generation() { return revision },
    get continuity() { return { token: continuity, reason, generation: revision } },
    dispose() { contractActive = false; changed(); for (const restore of restores.reverse()) restore(); edges.length = 0 } }
}
