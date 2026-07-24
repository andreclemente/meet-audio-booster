import { scanMeetParticipants, observeMeetParticipants, isGoogleParticipantSpeaking, hasLocalPresentation } from './participants.js'
import { createAssociationLearner, createFreshAlignmentTracker } from './association.js'
import { createRoutingState, routeGoogleAudio } from './router.js'
import { installLocalPresentationCaptureHook } from './presentation.js'
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

export function collectCurrentUiSpeakersAcrossRoots(participants, root = globalThis.document) {
  const rootsByParticipantId = new Map()
  for (const element of root?.querySelectorAll?.('[data-participant-id]') || []) {
    const participantId = element.getAttribute?.('data-participant-id')
    if (!participantId) continue
    if (!rootsByParticipantId.has(participantId)) rootsByParticipantId.set(participantId, [])
    rootsByParticipantId.get(participantId).push(element)
  }
  return collectCurrentUiSpeakers(participants, participant => {
    const roots = rootsByParticipantId.get(participant.participantId)
    return roots?.length
      ? roots.some(isGoogleParticipantSpeaking)
      : isGoogleParticipantSpeaking(participant.element)
  })
}

export function createWorkletSpeakerTracker({ confirmMs = 50 } = {}) {
  let confirmed = null
  let candidateKey = null
  let candidateSince = 0

  function result(routingState, participant = null, multiplier = 1) {
    return {
      routingState,
      activeParticipantKey: participant?.key || null,
      appliedParticipantKey: participant?.key || null,
      multiplier,
      candidateParticipantKey: candidateKey,
      candidateSince
    }
  }

  function reset(routingState = 'idle') {
    confirmed = null
    candidateKey = null
    candidateSince = 0
    return result(routingState)
  }

  function update({ now, speakers = [], hidden = false }) {
    if (hidden) return reset('hidden-tab')
    if (speakers.length > 1) return reset('ambiguous')

    const speaker = speakers[0] || null
    if (speaker) {
      if (confirmed?.key === speaker.key) {
        confirmed = speaker
        candidateKey = null
        candidateSince = 0
        return result('confirmed-speaker', confirmed, confirmed.value)
      }

      if (confirmed) confirmed = null
      if (candidateKey !== speaker.key) {
        candidateKey = speaker.key
        candidateSince = now
        return result('transitioning')
      }
      if (now - candidateSince < confirmMs) return result('transitioning')

      confirmed = speaker
      candidateKey = null
      candidateSince = 0
      return result('confirmed-speaker', confirmed, confirmed.value)
    }

    candidateKey = null
    candidateSince = 0
    // Meet's visual speaking marker is intermittent and can disappear for
    // arbitrary periods during one person's turn. Do not pulse a confirmed
    // gain back to unity merely because the marker is absent. Concrete safety
    // events above (another/overlapping speaker or hidden tab) still reset it.
    if (confirmed) return result('confirmed-speaker', confirmed, confirmed.value)
    return reset('idle')
  }

  return { update, reset }
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
  const workletSpeakerTracker = createWorkletSpeakerTracker()
  let restoreHook, restoreCaptureHook, observer, mutationTimer, reconcileTimer, mediaTimer, routingTimer, visibilityHandler, slotCounter = 0
  let capturePresentationActive = false
  let domPresentationActive = false

  function participants() { return visibleParticipants(state, 'google-meet') }
  function applyPresentationState() {
    const presenting = capturePresentationActive || domPresentationActive
    if (presenting === state.google.localPresentationActive) return presenting
    state.google.localPresentationActive = presenting
    if (presenting) {
      workletSpeakerTracker.reset('local-presentation-bypass')
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
  function setCapturePresentationActive(active) {
    capturePresentationActive = active
    if (!active) domPresentationActive = hasLocalPresentation()
    return applyPresentationState()
  }
  function syncPresentationState() {
    domPresentationActive = hasLocalPresentation()
    return applyPresentationState()
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
  function unregisterSlot(gain) {
    const index = state.google.slots.findIndex(slot => slot.gain === gain)
    if (index < 0) return
    state.google.slots[index].destroy()
    state.google.slots.splice(index, 1)
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
    return collectCurrentUiSpeakersAcrossRoots(participants())
  }
  function neutralizeHiddenTab() {
    workletSpeakerTracker.reset('hidden-tab')
    state.google.routing = { ...createRoutingState(), routingState: 'hidden-tab' }
    state.google.activeParticipantKey = null
    state.google.appliedParticipantKey = null
    state.google.routingState = 'hidden-tab'
    state.google.transitionGuard.candidateParticipantKey = null
    state.google.transitionGuard.candidateSince = 0
    setOutputs(1, true)
    setStatus('Meet tab hidden · using safe 100% volume')
  }
  function routeWorklet(now, speakers) {
    const hidden = Boolean(globalThis.document?.hidden)
    const routing = workletSpeakerTracker.update({ now, speakers, hidden })
    const active = state.participants.get(routing.appliedParticipantKey) || null
    const status = !participants().length ? 'Waiting for participants'
      : speakers.length > 1 ? 'Overlapping speakers · using safe 100% volume'
      : hidden ? 'Meet tab hidden · using safe 100% volume'
      : active ? `${active.name} · automatic routing` : `${participants().length} participants ready`
    const changed = routing.appliedParticipantKey !== state.google.appliedParticipantKey ||
      routing.routingState !== state.google.routingState
    state.google.activeParticipantKey = routing.activeParticipantKey
    state.google.appliedParticipantKey = routing.appliedParticipantKey
    state.google.routingState = routing.routingState
    state.google.transitionGuard.candidateParticipantKey = routing.candidateParticipantKey
    state.google.transitionGuard.candidateSince = routing.candidateSince
    setOutputs(routing.multiplier, changed || routing.multiplier === 1)
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
    if (globalThis.document?.hidden) {
      neutralizeHiddenTab()
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
    restoreCaptureHook = installLocalPresentationCaptureHook(setCapturePresentationActive)
    restoreHook = installAudioWorkletHook(registerSlot, unregisterSlot)
    reconcile(); scanMedia()
    observer = observeMeetParticipants(() => {
      syncPresentationState()
      clearTimeout(mutationTimer)
      mutationTimer = setTimeout(reconcile, 80)
    })
    reconcileTimer = setInterval(reconcile, 750)
    mediaTimer = setInterval(scanMedia, 500)
    routingTimer = setInterval(route, 30)
    visibilityHandler = () => {
      if (document.hidden) {
        neutralizeHiddenTab()
        updateLiveUi()
      } else route()
    }
    document.addEventListener('visibilitychange', visibilityHandler)
  }
  function stop() {
    observer?.disconnect(); clearTimeout(mutationTimer); clearInterval(reconcileTimer); clearInterval(mediaTimer); clearInterval(routingTimer)
    if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler)
    restoreCaptureHook?.()
    restoreHook?.()
    if (state.google.mode === 'media') setOutputs(1, true)
    for (const slot of state.google.slots) slot.destroy()
    state.google.slots = []
    media.destroy()
  }
  function applyParticipantGain(participant) {
    if (syncPresentationState()) return
    if (globalThis.document?.hidden) return
    // Pooled worklets expose no stable per-participant energy identity. Keep
    // the confirmed speaker latched through missing UI markers; concrete
    // speaker changes, overlap, presentation, and hidden tabs neutralize it.
    if (state.google.activeParticipantKey === participant.key) setOutputs(participant.value, true)
  }
  return { start, stop, route, applyParticipantGain, setOutputs, get pipelines() { return media.pipelines } }
}
