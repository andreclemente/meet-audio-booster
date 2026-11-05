import { scanMeetParticipants, observeMeetParticipants, isGoogleParticipantSpeaking, hasLocalPresentation, updateMissingParticipants } from './participants.js'
import { createAssociationLearner, createFreshAlignmentTracker } from './association.js'
import { createRoutingState, routeGoogleAudio, isQuietMediaTransition } from './router.js'
import { installLocalPresentationCaptureHook } from './presentation.js'
import { installAudioWorkletHook, createPooledSlot } from './audio-worklet.js'
import { createMediaPipelineManager } from './media-elements.js'
import { installRemoteMediaOwnership } from './media-ownership.js'
import { createNativeActivitySource } from './native-activity.js'
import { createParticipantLevelMeter, attributeLevelSample, sumTapPower, sumPipelinePower } from './levels.js'
import { createMeasurementContinuity } from './measurement-continuity.js'
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

  // Speaker evidence comes from Meet's own activity model, which keeps
  // updating while the tab is hidden, so visibility is not a routing input.
  function update({ now, speakers = [] }) {
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
    // Meet's activity is quantized and drops to zero between words. Do not
    // pulse a confirmed gain back to unity merely because it is quiet.
    // Concrete safety events (another or overlapping speaker, unknown
    // speaker data) still reset it.
    if (confirmed) return result('confirmed-speaker', confirmed, confirmed.value)
    return reset('idle')
  }

  return { update, reset }
}

export function applyMediaPipelineOutputs(pipelines, routing, multiplier, immediate = false) {
  const selectedId = routing?.routingState === 'confirmed-speaker' ? routing.appliedPipelineId : null
  const selectedKey = routing?.appliedParticipantKey
  const quiet = isQuietMediaTransition(pipelines, routing)
  for (const pipeline of pipelines) {
    const selected = pipeline.id === selectedId && pipeline.associationReliable && pipeline.participantKey === selectedKey
    const quietOwner = quiet && routing.quietIdentity.pipeline === pipeline
    pipeline.set(selected ? multiplier : 1, immediate || (!selected && !quietOwner) || !pipeline.connected)
  }
}

export function activateMediaModePipelines(pipelines, routing) {
  // Validate against the whole pool: a newly active second stream must cancel
  // a quiet fade even if this scan runs before the next routing tick.
  applyMediaPipelineOutputs(pipelines, routing, routing?.multiplier ?? 1)
}

export function resolveLocalPresentationActive({ captureActive, domActive, captureLifecycleSeen }) {
  return captureLifecycleSeen ? captureActive : (captureActive || domActive)
}

export function createGoogleMeetController({ state, context, setStatus, renderSoon, updateLiveUi, onLevelSample = () => {}, onLevelReset = () => {}, onStop = () => {}, mediaOwnership = installRemoteMediaOwnership() }) {
  const learner = createAssociationLearner()
  const alignmentTracker = createFreshAlignmentTracker()
  const media = createMediaPipelineManager(context, { accepts: stream => mediaOwnership.accepts(stream) })
  const workletSpeakerTracker = createWorkletSpeakerTracker()
  const nativeActivity = createNativeActivitySource()
  const levelMeter = createParticipantLevelMeter()
  const observeMeasurement = createMeasurementContinuity()
  let stopped = false
  const selfIds = new Set(), presentationIds = new Set()
  let restoreHook, restoreCaptureHook, observer, mutationTimer, reconcileTimer, mediaTimer, routingTimer, visibilityHandler, slotCounter = 0
  let capturePresentationActive = false
  let domPresentationActive = false
  let captureLifecycleSeen = false

  function participants() { return visibleParticipants(state, 'google-meet') }
  // Everyone known in this call, with or without a rendered tile (never self).
  function knownParticipants() { return [...state.participants.values()].filter(item => item.platform === 'google-meet' && !selfIds.has(item.participantId) && !presentationIds.has(item.participantId)) }
  function applyPresentationState() {
    const presenting = resolveLocalPresentationActive({
      captureActive: capturePresentationActive,
      domActive: domPresentationActive,
      captureLifecycleSeen
    })
    if (presenting === state.google.localPresentationActive) return presenting
    state.google.localPresentationActive = presenting
    renderSoon()
    return presenting
  }
  function setCapturePresentationActive(active) {
    captureLifecycleSeen = true
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
  function registerSlot(gain, tap = null, audibleMeter = null) {
    if (state.google.slots.some(slot => slot.gain === gain)) return
    state.google.slots.push(createPooledSlot(gain, `slot-${++slotCounter}`, tap, audibleMeter))
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
    for (const data of scanMeetParticipants(document, selfIds, presentationIds)) {
      // Only a call tile or a confirmed call member is a person in the call;
      // a People-list or lobby entry (someone asking to join) is not.
      if (!data.element?.getAttribute?.('data-requested-participant-id') && !nativeActivity.isMember(data.participantId)) continue
      // A new row needs a person's mic indicator, so a share never flashes in.
      if (!data.hasMicrophone && !state.participants.has(data.key)) continue
      found.add(data.key)
      upsertParticipant(state, {
        ...data, platform: 'google-meet', present: true, lastSeenAt: now,
        extra: { participantId: data.participantId, element: data.element }
      })
    }
    updateMissingParticipants(state.participants.values(), found, { now, selfIds, presentationIds, isMember: nativeActivity.isMember })
    const isSelfKey = key => selfIds.has(state.participants.get(key)?.participantId)
    if ([state.google.activeParticipantKey, state.google.appliedParticipantKey,
      state.google.transitionGuard.candidateParticipantKey, state.google.routing?.appliedParticipantKey,
      state.google.routing?.lastConfirmedParticipantKey, state.google.routing?.candidateParticipantKey].some(isSelfKey)) {
      // Invalidate only routing that referenced the newly verified local ID.
      // In particular, silence must not keep the worklet's former self latched.
      workletSpeakerTracker.reset()
      state.google.routing = createRoutingState()
      state.google.activeParticipantKey = null
      state.google.appliedParticipantKey = null
      state.google.routingState = 'idle'
      state.google.transitionGuard.candidateParticipantKey = null
      state.google.transitionGuard.candidateSince = 0
      setOutputs(1, true)
    }
    const signature = participants().map(item => `${item.key}:${item.name}`).join('|')
    if (signature !== state.google.rosterSignature) { state.google.rosterSignature = signature; renderSoon() }
  }
  function scanMedia() {
    mediaOwnership.refresh()
    media.scan()
    state.google.mediaPipelines = media.pipelines
    if (state.google.slots.length) setMode('worklet')
    else if (media.hasAudio && performance.now() - state.google.modeStartedAt > 1200) setMode('media')
    if (state.google.mode === 'media') activateMediaModePipelines(media.pipelines, state.google.routing)
  }
  function refreshMediaOwnership() {
    mediaOwnership.refresh()
    media.prune()
    state.google.mediaPipelines = media.pipelines
  }
  function setOutputs(multiplier, immediate = false) {
    refreshMediaOwnership()
    if (state.google.mode === 'media') applyMediaPipelineOutputs(media.pipelines, state.google.routing, multiplier, immediate)
    else for (const slot of state.google.slots) slot.set(multiplier, immediate)
  }
  function currentSpeakers(now) {
    const known = knownParticipants()
    const activity = nativeActivity.read(participants(), globalThis.document, now, { known, selfIds })
    for (const participant of known) {
      participant.speaking = activity.available && activity.speakers.includes(participant)
      if (participant.speaking) participant.lastSpeakingAt = now
    }
    // Counts and a source label only: never participant ids or names.
    state.google.speakerSource = activity.available ? 'meet-activity' : 'unavailable'
    state.google.activitySource = activity.source
    state.google.membershipTrusted = nativeActivity.membershipTrusted
    state.google.unknownSpeakerCount = activity.unknown.length + activity.unknownSpeakers
    return activity
  }
  function neutralize(routingState, status) {
    workletSpeakerTracker.reset(routingState)
    state.google.routing = { ...createRoutingState(), routingState }
    state.google.activeParticipantKey = null
    state.google.appliedParticipantKey = null
    state.google.routingState = routingState
    state.google.transitionGuard.candidateParticipantKey = null
    state.google.transitionGuard.candidateSince = 0
    setOutputs(1, true)
    setStatus(status)
  }
  function routeWorklet(now, speakers) {
    const routing = workletSpeakerTracker.update({ now, speakers })
    const active = state.participants.get(routing.appliedParticipantKey) || null
    const status = active ? `${active.name} · automatic routing`
      : speakers.length > 1 ? 'Overlapping speakers · using safe 100% volume'
      : !participants().length ? 'Waiting for participants' : `${participants().length} participants ready`

    state.google.activeParticipantKey = routing.activeParticipantKey
    state.google.appliedParticipantKey = routing.appliedParticipantKey
    state.google.routingState = routing.routingState
    state.google.transitionGuard.candidateParticipantKey = routing.candidateParticipantKey
    state.google.transitionGuard.candidateSince = routing.candidateSince
    setOutputs(routing.multiplier, routing.routingState !== 'confirmed-speaker')
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
      // A tileless participant is routable only while the registry names them as the speaker.
      now, participants: Object.fromEntries([...participants(), ...speakers].map(item => [item.key, item])),
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
    setStatus(!media.pipelines.length ? 'Remote audio ownership unavailable · using native playback'
      : active ? `${active.name} · automatic routing` : labels[routing.routingState] || `${participants().length} participants ready`)
  }
  // Sample after routing; only accepted fresh frames can drive Auto Balance.
  function sampleLevels(now, activity = null) {
    const g = state.google
    const invalidation = observeMeasurement(g, media.pipelines)
    if (invalidation) {
      levelMeter.reset()
      onLevelReset(now, invalidation)
    }
    const attributedKey = activity && attributeLevelSample({
      available: activity.available, speakers: activity.speakers, routingState: g.routingState,
      appliedParticipantKey: g.appliedParticipantKey,
      // Media graphs contain only verified remote audio; worklet semantics stay
      // unchanged because their pooled source has no equivalent provenance.
      localPresentationActive: g.localPresentationActive && g.mode !== 'media'
    })
    try {
      const accepted = levelMeter.tick({
        // A hidden tile is not a departure; keep known membership evidence.
        now, participantKeys: knownParticipants().map(person => person.key), attributedKey,
        readPower: () => g.mode === 'media' ? sumPipelinePower(media.pipelines) : g.mode === 'worklet' ? sumTapPower(g.slots) : 0
      })
      onLevelSample(now, accepted ? attributedKey : null)
    } catch {}
  }
  function route() {
    if (stopped) return
    refreshMediaOwnership()
    const now = Date.now()
    const activity = currentSpeakers(now)
    if (activity.unknownSpeakers) neutralize('unknown-speaker', 'Unrecognized speaker · using safe 100% volume')
    else if (!activity.available) {
      neutralize('speaker-data-unavailable', participants().length
        ? 'Speaker data unavailable · using safe 100% volume'
        : 'Waiting for participants')
    }
    if (activity.unknownSpeakers || !activity.available) {
      sampleLevels(now, activity)
      updateLiveUi()
      return
    }
    const speakers = activity.speakers
    if (state.google.mode === 'media') routeMedia(now, speakers)
    else routeWorklet(now, speakers)
    sampleLevels(now, activity)
    updateLiveUi()
  }
  function start() {
    stopped = false
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
    visibilityHandler = () => route()
    document.addEventListener('visibilitychange', visibilityHandler)
  }
  function stop() {
    stopped = true
    onStop()
    observer?.disconnect(); clearTimeout(mutationTimer); clearInterval(reconcileTimer); clearInterval(mediaTimer); clearInterval(routingTimer)
    if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler)
    restoreCaptureHook?.()
    restoreHook?.()
    if (state.google.mode === 'media') setOutputs(1, true)
    for (const slot of state.google.slots) slot.destroy()
    state.google.slots = []
    media.destroy()
    state.google.mediaPipelines = []
    mediaOwnership.dispose()
    selfIds.clear(); presentationIds.clear()
    workletSpeakerTracker.reset()
    nativeActivity.reset()
    levelMeter.reset()
  }
  function applyParticipantGain(participant) {
    syncPresentationState()
    // Preserve the router's confirmed ownership, including its safety guards.
    if (state.google.activeParticipantKey === participant.key) setOutputs(participant.value)
  }
  return {
    start, stop, route, applyParticipantGain, setOutputs,
    levelFor: key => levelMeter.levelFor(key),
    get pipelines() { return media.pipelines }
  }
}
