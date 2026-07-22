import { scanMeetParticipants, observeMeetParticipants, isGoogleParticipantSpeaking, hasLocalPresentation } from './participants.js'
import { createAssociationLearner, createFreshAlignmentTracker } from './association.js'
import { createRoutingState, routeGoogleAudio } from './router.js'
import { installAudioWorkletHook, createPooledSlot } from './audio-worklet.js'
import { createMediaPipelineManager } from './media-elements.js'
import { upsertParticipant, visibleParticipants } from '../../state.js'

export function collectCurrentUiSpeakers(participants, isSpeaking = participant => isGoogleParticipantSpeaking(participant.element)) {
  return participants.filter(participant => {
    participant.speaking = isSpeaking(participant)
    if (participant.speaking) participant.lastSpeakingAt = Date.now()
    return participant.speaking
  })
}

export function applyMediaPipelineOutputs(pipelines, routing, multiplier, immediate = false) {
  const selectedId = routing?.routingState === 'confirmed-speaker' ? routing.appliedPipelineId : null
  const selectedKey = routing?.appliedParticipantKey
  for (const pipeline of pipelines) {
    const selected = pipeline.id === selectedId && pipeline.associationReliable && pipeline.participantKey === selectedKey
    pipeline.set(selected ? multiplier : 1, immediate)
  }
}

export function activateMediaModePipelines(pipelines, routing) {
  applyMediaPipelineOutputs(pipelines, routing, routing?.multiplier ?? 1, true)
}

export function createGoogleMeetController({ state, context, setStatus, renderSoon, updateLiveUi }) {
  const learner = createAssociationLearner()
  const alignmentTracker = createFreshAlignmentTracker()
  const media = createMediaPipelineManager(context)
  let restoreHook, observer, mutationTimer, reconcileTimer, mediaTimer, routingTimer, slotCounter = 0

  function participants() { return visibleParticipants(state, 'google-meet') }
  function syncPresentationState() {
    const presenting = hasLocalPresentation()
    if (presenting === state.google.localPresentationActive) return presenting
    state.google.localPresentationActive = presenting
    if (presenting) {
      for (const slot of state.google.slots) slot.release()
      for (const pipeline of media.pipelines) pipeline.deactivate()
      state.google.activeParticipantKey = null
      state.google.appliedParticipantKey = null
      state.google.routingState = 'local-presentation-bypass'
      state.google.transitionGuard.candidateParticipantKey = null
      state.google.transitionGuard.candidateSince = 0
    }
    renderSoon()
    return presenting
  }
  function setMode(mode) {
    if (state.google.mode === mode) return
    state.google.mode = mode
    if (mode === 'worklet') {
      for (const pipeline of media.pipelines) pipeline.deactivate()
    } else if (mode === 'media') applyMediaPipelineOutputs(media.pipelines, null, 1, true)
    renderSoon()
  }
  function registerSlot(gain) {
    if (state.google.slots.some(slot => slot.gain === gain)) return
    state.google.slots.push(createPooledSlot(gain, `slot-${++slotCounter}`))
    setMode('worklet')
    syncPresentationState()
    renderSoon()
  }
  function reconcile() {
    const now = Date.now()
    syncPresentationState()
    const found = new Set()
    for (const data of scanMeetParticipants()) {
      found.add(data.key)
      upsertParticipant(state, {
        ...data, platform: 'google-meet', present: true, lastSeenAt: now,
        extra: { participantId: data.participantId, element: data.element }
      })
    }
    for (const participant of state.participants.values()) {
      if (participant.platform !== 'google-meet' || found.has(participant.key)) continue
      participant.speaking = false
      if (now - participant.lastSeenAt > 8000) participant.present = false
    }
    const signature = participants().map(item => `${item.key}:${item.name}`).join('|')
    if (signature !== state.google.rosterSignature) { state.google.rosterSignature = signature; renderSoon() }
  }
  function scanMedia() {
    if (state.google.localPresentationActive) {
      for (const pipeline of media.pipelines) pipeline.deactivate()
      return
    }
    media.scan()
    state.google.mediaPipelines = media.pipelines
    if (state.google.slots.length) setMode('worklet')
    else if (media.pipelines.length && performance.now() - state.google.modeStartedAt > 1200) setMode('media')
    if (state.google.mode === 'media') activateMediaModePipelines(media.pipelines, state.google.routing)
  }
  function setOutputs(multiplier, immediate = false) {
    if (state.google.mode === 'media') applyMediaPipelineOutputs(media.pipelines, state.google.routing, multiplier, immediate)
    else for (const slot of state.google.slots) slot.set(multiplier, immediate)
  }
  function currentUiSpeakers() {
    return collectCurrentUiSpeakers(participants())
  }
  function routeWorklet(now, speakers) {
    let active = speakers.length === 1 ? speakers[0] : null
    let status = !participants().length ? 'Waiting for participants'
      : speakers.length > 1 ? 'Overlapping speakers · using safe 100% volume'
      : active ? `${active.name} · automatic routing` : `${participants().length} participants ready`
    const nextKey = active?.key || null
    const guard = state.google.transitionGuard
    if (nextKey !== state.google.activeParticipantKey) {
      setOutputs(1, true)
      state.google.activeParticipantKey = null
      state.google.appliedParticipantKey = null
      state.google.routingState = nextKey ? 'transitioning' : speakers.length > 1 ? 'ambiguous' : 'idle'
      if (nextKey !== guard.candidateParticipantKey) {
        guard.candidateParticipantKey = nextKey
        guard.candidateSince = now
      } else if (nextKey && now - guard.candidateSince >= 50) {
        state.google.activeParticipantKey = nextKey
        state.google.appliedParticipantKey = nextKey
        state.google.routingState = 'confirmed-speaker'
        guard.candidateParticipantKey = null
        guard.candidateSince = 0
        setOutputs(active.value, true)
      }
    } else if (active) {
      state.google.routingState = 'confirmed-speaker'
      state.google.appliedParticipantKey = active.key
      setOutputs(active.value)
    } else {
      guard.candidateParticipantKey = null
      guard.candidateSince = 0
      state.google.routingState = speakers.length > 1 ? 'ambiguous' : 'idle'
      state.google.appliedParticipantKey = null
      setOutputs(1)
    }
    setStatus(status)
  }
  function routeMedia(now, speakers) {
    for (const pipeline of media.pipelines) pipeline.sample()
    const energetic = media.pipelines.filter(pipeline => pipeline.activeByEnergy)
    const alignment = alignmentTracker.observe(now, speakers.map(item => item.key), energetic.map(item => item.id))
    if (alignment.mayLearn && speakers.length === 1 && energetic.length === 1) {
      Object.assign(energetic[0], learner.observe(energetic[0].id, speakers[0].key, { exclusiveUi: true, exclusiveEnergy: true }))
    }
    state.google.routing = routeGoogleAudio(state.google.routing || createRoutingState(), {
      now, participants: Object.fromEntries(participants().map(item => [item.key, item])),
      uiSpeakerKeys: speakers.map(item => item.key), pipelines: media.pipelines
    })
    const routing = state.google.routing
    state.google.routingState = routing.routingState
    state.google.activeParticipantKey = routing.appliedParticipantKey
    state.google.appliedParticipantKey = routing.appliedParticipantKey
    state.google.transitionGuard.candidateParticipantKey = routing.candidateParticipantKey
    state.google.transitionGuard.candidateSince = routing.candidateSince
    setOutputs(routing.multiplier)
    const labels = {
      'multiple-active-streams': 'Multiple active streams · using safe 100% volume',
      'stale-ui-speaker': 'Stale speaker indicator · using safe 100% volume',
      'no-reliable-association': 'Learning audio stream · using safe 100% volume',
      ambiguous: 'Overlapping speakers · using safe 100% volume'
    }
    const active = state.participants.get(routing.appliedParticipantKey)
    setStatus(active ? `${active.name} · automatic routing` : labels[routing.routingState] || `${participants().length} participants ready`)
  }
  function route() {
    if (state.google.localPresentationActive) {
      for (const slot of state.google.slots) slot.release()
      if (state.google.mode === 'media') for (const pipeline of media.pipelines) pipeline.deactivate()
      state.google.activeParticipantKey = null
      state.google.appliedParticipantKey = null
      state.google.routingState = 'local-presentation-bypass'
      state.google.transitionGuard.candidateParticipantKey = null
      state.google.transitionGuard.candidateSince = 0
      setStatus('Presenting · own presentation audio bypassed')
      updateLiveUi()
      return
    }
    const now = Date.now()
    const speakers = currentUiSpeakers()
    if (state.google.mode === 'media') routeMedia(now, speakers)
    else routeWorklet(now, speakers)
    updateLiveUi()
  }
  function start() {
    restoreHook = installAudioWorkletHook(registerSlot)
    reconcile(); scanMedia()
    observer = observeMeetParticipants(() => {
      syncPresentationState()
      clearTimeout(mutationTimer)
      mutationTimer = setTimeout(reconcile, 80)
    })
    reconcileTimer = setInterval(reconcile, 750)
    mediaTimer = setInterval(scanMedia, 500)
    routingTimer = setInterval(route, 30)
  }
  function stop() {
    observer?.disconnect(); clearTimeout(mutationTimer); clearInterval(reconcileTimer); clearInterval(mediaTimer); clearInterval(routingTimer)
    restoreHook?.()
    if (state.google.localPresentationActive) for (const slot of state.google.slots) slot.release()
    else setOutputs(1, true)
    media.destroy()
  }
  function applyParticipantGain(participant) {
    if (syncPresentationState()) return
    // Pooled worklets expose no stable per-participant energy identity, so
    // pre-UI stale detection is unavailable; UI edges neutralize first and
    // no marker hold or permanent slot mapping is retained.
    if (state.google.activeParticipantKey === participant.key) setOutputs(participant.value, true)
  }
  return { start, stop, route, applyParticipantGain, setOutputs, get pipelines() { return media.pipelines } }
}
