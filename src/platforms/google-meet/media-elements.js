import { attachPipelineAnalyser } from './active-speaker.js'
import { writeAudioParam } from '../../shared/audio.js'

export function mediaStreamKey(stream) {
  if (!stream) return ''
  return [stream.id || 'stream', ...(stream.getAudioTracks?.() || []).map(track => track.id)].join('|')
}

export function createMediaElementPipeline(context, audio, id, accepts = () => true, onRelease = () => {}) {
  const stream = audio.srcObject
  const tracks = [...(stream?.getAudioTracks?.() || [])]
  if (!accepts(stream) || !tracks.length || tracks.some(track => track.readyState === 'ended')) return null
  let destroyed = false
  function eligible() {
    // An element can change sources between scans. Restore it before any
    // activation can suppress its now-unowned native playback.
    for (const element of [...pipeline.elements]) {
      if (element.srcObject !== stream || element.isConnected === false) pipeline.releaseElement(element)
    }
    const current = stream?.getAudioTracks?.() || []
    return !destroyed && pipeline.elements.size > 0 && accepts(stream) && current.length === tracks.length &&
      tracks.every(track => track.readyState !== 'ended' && current.includes(track))
  }
  let source, gain, analyser
  try {
    source = context.createMediaStreamSource(stream)
    gain = context.createGain()
    source.connect(gain)
    analyser = attachPipelineAnalyser(context, source)
  } catch {
    try { source?.disconnect() } catch {}
    try { gain?.disconnect() } catch {}
    return null
  }
  const pipeline = {
    id, streamKey: mediaStreamKey(stream), stream, tracks, source, gain, analyser,
    elements: new Set([audio]), originalStates: new Map(), connected: false,
    participantKey: null, associationReliable: false, activeByEnergy: false, rms: 0,
    appliedMultiplier: 1, targetValue: 1,
    eligible,
    sample() {
      if (!eligible()) { this.destroy(); return this }
      Object.assign(this, analyser.sample()); return this
    },
    activate() {
      if (!eligible()) { this.destroy(); return false }
      if (!this.connected) {
        // Only suppress native playback after the replacement graph exists and
        // has successfully reached the destination.
        try { gain.connect(context.destination); this.connected = true } catch { return false }
      }
      for (const element of this.elements) {
        if (!this.originalStates.has(element)) this.originalStates.set(element, { muted: element.muted, volume: element.volume })
        element.muted = true
        element.volume = 0
      }
      context.resume?.().catch?.(() => {})
      return true
    },
    deactivate() {
      writeAudioParam(gain.gain, 1, { context })
      this.appliedMultiplier = 1
      this.targetValue = 1
      if (this.connected) { try { gain.disconnect() } catch {}; this.connected = false }
      for (const [element, original] of this.originalStates) {
        element.muted = original.muted
        element.volume = original.volume
      }
      this.originalStates.clear()
    },
    releaseElement(element) {
      const original = this.originalStates.get(element)
      if (original) {
        element.muted = original.muted
        element.volume = original.volume
        this.originalStates.delete(element)
      }
      this.elements.delete(element)
      onRelease(element)
    },
    set(multiplier, immediate = false) {
      if (!eligible()) { this.destroy(); return }
      const safe = Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1
      this.appliedMultiplier = safe
      this.targetValue = safe
      // Activation is immediate, but a normal selected gain is still ramped.
      // Repeated scans/route ticks must not restart or snap that ramp.
      if ((this.connected || immediate) && this.activate()) writeAudioParam(gain.gain, safe, { context, immediate: immediate && safe === 1 })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      this.rms = 0
      this.activeByEnergy = false
      this.deactivate()
      analyser.disconnect()
      try { source.disconnect() } catch {}
      try { gain.disconnect() } catch {}
    }
  }
  return pipeline
}

export function createMediaPipelineManager(context, { nextId = (() => { let id = 0; return () => `media-${++id}` })(), accepts = () => true } = {}) {
  let pipelines = []
  let hasAudio = false
  const byElement = new WeakMap()
  function prune() {
    for (const pipeline of [...pipelines]) if (!pipeline.eligible()) remove(pipeline)
  }
  function scan(root = document) {
    prune()
    hasAudio = false
    const seen = new Set()
    for (const audio of root.querySelectorAll?.('audio') || []) {
      const stream = audio.srcObject
      const tracks = stream?.getAudioTracks?.() || []
      if (tracks.some(track => track.readyState !== 'ended')) hasAudio = true
      if (!accepts(stream) || !tracks.length || tracks.some(track => track.readyState === 'ended')) {
        const previous = byElement.get(audio)
        if (previous) { previous.releaseElement(audio); byElement.delete(audio) }
        continue
      }
      const key = mediaStreamKey(stream)
      seen.add(key)
      const previous = byElement.get(audio)
      if (previous?.stream === stream && previous.elements.has(audio)) continue
      if (previous) { previous.releaseElement(audio); byElement.delete(audio) }
      let pipeline = pipelines.find(item => item.stream === stream)
      if (!pipeline) {
        pipeline = createMediaElementPipeline(context, audio, nextId(), accepts, element => byElement.delete(element))
        if (!pipeline) continue
        pipelines.push(pipeline)
      } else pipeline.elements.add(audio)
      byElement.set(audio, pipeline)
      if (pipeline.connected) pipeline.activate()
    }
    for (const pipeline of [...pipelines]) {
      for (const element of [...pipeline.elements]) {
        if (!element.isConnected || element.srcObject !== pipeline.stream || !accepts(element.srcObject)) {
          pipeline.releaseElement(element)
          byElement.delete(element)
        }
      }
      const live = pipeline.tracks.some(track => track.readyState !== 'ended')
      if (!seen.has(pipeline.streamKey) || !pipeline.elements.size || !live) remove(pipeline)
    }
    return pipelines
  }
  function remove(pipeline) {
    for (const element of pipeline.elements) byElement.delete(element)
    pipeline.destroy()
    pipelines = pipelines.filter(item => item !== pipeline)
  }
  function destroy() { for (const pipeline of [...pipelines]) remove(pipeline) }
  return { scan, prune, destroy, get hasAudio() { return hasAudio }, get pipelines() { return pipelines } }
}
