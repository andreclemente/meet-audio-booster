import { installRtcHook } from './rtc-hook.js'
import { getJitsiName, getJitsiParticipantId, isJitsiRemoteAudio } from './participants.js'
import { routeJitsiParticipant } from './router.js'
import { cleanName } from '../../shared/dom.js'
import { upsertParticipant, visibleParticipants } from '../../state.js'

export function createJitsiController({ state, context, renderSoon, updateLiveUi }) {
  let restoreHook
  const originals = new Map()

  function matchingAudio(pipeline, audio) {
    const stream = audio.srcObject
    if (!stream?.getAudioTracks) return false
    const trackIds = stream.getAudioTracks().map(track => track.id)
    return trackIds.includes(pipeline.originalTrack.id) || pipeline.streamIds.includes(stream.id)
  }
  function muteOriginalPlayback() {
    for (const pipeline of state.jitsi.pipelines.filter(item => item.originalTrack.readyState !== 'ended')) {
      for (const audio of document.querySelectorAll('audio')) {
        if (!matchingAudio(pipeline, audio)) continue
        if (!originals.has(audio)) originals.set(audio, { muted: audio.muted, volume: audio.volume })
        audio.muted = true
        audio.volume = 0
      }
    }
  }
  function restoreUnusedElements() {
    for (const [audio, original] of originals) {
      const stillUsed = state.jitsi.pipelines.some(item => item.originalTrack.readyState !== 'ended' && matchingAudio(item, audio))
      if (stillUsed) continue
      audio.muted = original.muted
      audio.volume = original.volume
      originals.delete(audio)
    }
  }
  function teardown(pipeline) {
    pipeline.clonedTrack?.stop?.()
    try { pipeline.source?.disconnect() } catch {}
    try { pipeline.gain?.disconnect() } catch {}
    pipeline.present = false
    state.jitsi.pipelines = state.jitsi.pipelines.filter(item => item !== pipeline)
    restoreUnusedElements()
  }
  function onTrack(event) {
    const track = event.track
    if (!isJitsiRemoteAudio(track, event.streams)) return
    const participantId = getJitsiParticipantId(event.streams)
    const streamIds = (event.streams || []).map(stream => stream.id)
    const streamKey = streamIds.join('|') || track.id
    const key = participantId ? `id:${participantId}` : `stream:${streamKey}`
    const existing = state.participants.get(key)
    if (existing?.clonedTrack?.readyState !== 'ended') return
    let clonedTrack, source, gain
    try {
      clonedTrack = track.clone()
      source = context.createMediaStreamSource(new MediaStream([clonedTrack]))
      gain = context.createGain()
      source.connect(gain)
      gain.connect(context.destination)
    } catch {
      clonedTrack?.stop?.()
      try { source?.disconnect() } catch {}
      try { gain?.disconnect() } catch {}
      return
    }
    const index = visibleParticipants(state, 'jitsi').length
    const participant = upsertParticipant(state, {
      key, platform: 'jitsi', name: cleanName(getJitsiName(participantId, `Remote participant ${index + 1}`)), present: true,
      extra: { participantId, streamKey, streamIds, originalTrack: track, clonedTrack, source, gain }
    })
    if (!state.jitsi.pipelines.includes(participant)) state.jitsi.pipelines.push(participant)
    routeJitsiParticipant(participant, participant.value)
    // Replacement is connected before native playback is suppressed.
    muteOriginalPlayback()
    context?.resume?.().catch?.(() => {})
    track.addEventListener?.('ended', () => { teardown(participant); renderSoon() }, { once: true })
    renderSoon()
  }
  function keepAlive() {
    muteOriginalPlayback()
    context?.resume?.().catch?.(() => {})
    for (const pipeline of [...state.jitsi.pipelines]) {
      if (pipeline.originalTrack?.readyState === 'ended') teardown(pipeline)
      else { pipeline.present = true; routeJitsiParticipant(pipeline, pipeline.value) }
    }
    updateLiveUi()
  }
  function start() {
    restoreHook = installRtcHook(onTrack)
    state.jitsi.keepAliveTimer = setInterval(keepAlive, 1000)
  }
  function stop() {
    restoreHook?.()
    clearInterval(state.jitsi.keepAliveTimer)
    for (const pipeline of [...state.jitsi.pipelines]) teardown(pipeline)
    restoreUnusedElements()
  }
  return { start, stop, onTrack, applyParticipantGain: routeJitsiParticipant }
}
