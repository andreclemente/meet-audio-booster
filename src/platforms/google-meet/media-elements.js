import { attachPipelineAnalyser } from './active-speaker.js'
import { writeAudioParam } from '../../shared/audio.js'

export function mediaStreamKey(stream) {
  if (!stream) return ''
  return [stream.id || 'stream', ...(stream.getAudioTracks?.() || []).map(track => track.id)].join('|')
}

export function createMediaElementPipeline(context, audio, id) {
  const stream = audio.srcObject
  const tracks = stream?.getAudioTracks?.() || []
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
    sample() { Object.assign(this, analyser.sample()); return this },
    activate() {
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
    },
    set(multiplier, immediate = false) {
      const safe = Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1
      this.appliedMultiplier = safe
      this.targetValue = safe
      if ((this.connected || immediate) && this.activate()) writeAudioParam(gain.gain, safe)
    },
    destroy() {
      this.deactivate()
      analyser.disconnect()
      try { source.disconnect() } catch {}
      try { gain.disconnect() } catch {}
    }
  }
  return pipeline
}

export function createMediaPipelineManager(context, { nextId = (() => { let id = 0; return () => `media-${++id}` })() } = {}) {
  let pipelines = []
  const byElement = new WeakMap()
  function scan(root = document) {
    const seen = new Set()
    for (const audio of root.querySelectorAll?.('audio') || []) {
      const stream = audio.srcObject
      const tracks = stream?.getAudioTracks?.() || []
      if (!tracks.length || tracks.every(track => track.readyState === 'ended')) continue
      const key = mediaStreamKey(stream)
      seen.add(key)
      const previous = byElement.get(audio)
      if (previous?.streamKey === key) continue
      if (previous) { previous.releaseElement(audio); byElement.delete(audio) }
      let pipeline = pipelines.find(item => item.streamKey === key)
      if (!pipeline) {
        pipeline = createMediaElementPipeline(context, audio, nextId())
        if (!pipeline) continue
        pipelines.push(pipeline)
      } else pipeline.elements.add(audio)
      byElement.set(audio, pipeline)
      if (pipeline.connected) pipeline.activate()
    }
    for (const pipeline of [...pipelines]) {
      for (const element of [...pipeline.elements]) {
        if (!element.isConnected || mediaStreamKey(element.srcObject) !== pipeline.streamKey) pipeline.releaseElement(element)
      }
      const live = pipeline.tracks.some(track => track.readyState !== 'ended')
      if (!seen.has(pipeline.streamKey) || !pipeline.elements.size || !live) remove(pipeline)
    }
    return pipelines
  }
  function remove(pipeline) {
    pipeline.destroy()
    pipelines = pipelines.filter(item => item !== pipeline)
  }
  function destroy() { for (const pipeline of [...pipelines]) remove(pipeline) }
  return { scan, destroy, get pipelines() { return pipelines } }
}
