import { SPEAKER_CONFIRM_MS } from '../../shared/constants.js'

export function createRoutingState() {
  return {
    routingState: 'idle',
    appliedParticipantKey: null,
    appliedPipelineId: null,
    lastConfirmedParticipantKey: null,
    candidateParticipantKey: null,
    candidateSince: 0,
    multiplier: 1
  }
}

function neutral(state, routingState, candidate = null, now = 0) {
  return {
    ...state,
    routingState,
    appliedParticipantKey: null,
    appliedPipelineId: null,
    candidateParticipantKey: candidate,
    candidateSince: candidate === state.candidateParticipantKey ? state.candidateSince : now,
    multiplier: 1,
    confirmedIdentity: null,
    quietIdentity: null
  }
}

// This is permission for a bounded fade to unity, never permission to retain
// the old gain. Keep the exact pipeline/stream/participant identity so neither
// a periodic scan nor a reused ID can extend it to a different owner.
export function isQuietMediaTransition(pipelines, routing) {
  const identity = routing?.quietIdentity
  if (!identity || routing.routingState !== 'energy-idle') return false
  const { pipeline, streamKey, stream, participant, participantKey } = identity
  if (!stream || !pipeline.tracks?.length || !pipeline.elements?.size) return false
  const currentTracks = stream.getAudioTracks?.() || []
  return pipelines.includes(pipeline) && !pipelines.some(item => item.activeByEnergy) &&
    pipeline.streamKey === streamKey && pipeline.stream === stream && pipeline.associationReliable &&
    pipeline.participantKey === participantKey && participant.present !== false &&
    pipeline.tracks.every(track => track.readyState === 'live') &&
    [...pipeline.elements].every(element => element.isConnected !== false && element.srcObject === stream) &&
    currentTracks.length === pipeline.tracks.length && pipeline.tracks.every(track => currentTracks.includes(track))
}

export function routeGoogleAudio(previous = createRoutingState(), observation = {}) {
  const now = observation.now ?? Date.now()
  const participants = observation.participants || {}
  const ui = [...new Set(observation.uiSpeakerKeys || [])]
  const active = (observation.pipelines || []).filter(pipeline => pipeline.activeByEnergy)

  if (active.length > 1) return neutral(previous, 'multiple-active-streams', null, now)
  if (ui.length > 1) return neutral(previous, 'ambiguous', null, now)
  if (!active.length) {
    const identity = previous.routingState === 'confirmed-speaker' ? previous.confirmedIdentity : previous.quietIdentity
    const quiet = { ...neutral(previous, 'energy-idle', null, now), quietIdentity: identity }
    if (identity && participants[identity.participantKey] === identity.participant &&
      (!ui.length || ui[0] === identity.participantKey) && isQuietMediaTransition(observation.pipelines || [], quiet)) return quiet
    return neutral(previous, ui.length ? 'stale-ui-speaker' : 'idle', null, now)
  }

  const pipeline = active[0]
  const energyKey = pipeline.associationReliable ? pipeline.participantKey : null
  if (!energyKey) return neutral(previous, 'no-reliable-association', null, now)
  if (ui.length && ui[0] !== energyKey) return neutral(previous, 'stale-ui-speaker', null, now)
  if (!participants[energyKey]) return neutral(previous, 'no-reliable-association', null, now)

  if (previous.lastConfirmedParticipantKey && previous.lastConfirmedParticipantKey !== energyKey && previous.candidateParticipantKey !== energyKey) {
    return neutral(previous, 'transitioning', energyKey, now)
  }
  if (previous.candidateParticipantKey === energyKey && previous.appliedParticipantKey === null && previous.routingState === 'transitioning' && now - previous.candidateSince < SPEAKER_CONFIRM_MS) {
    return neutral(previous, 'transitioning', energyKey, now)
  }

  const participant = participants[energyKey]
  return {
    ...previous,
    routingState: 'confirmed-speaker',
    appliedParticipantKey: energyKey,
    appliedPipelineId: pipeline.id,
    lastConfirmedParticipantKey: energyKey,
    candidateParticipantKey: null,
    candidateSince: 0,
    quietIdentity: null,
    confirmedIdentity: { pipeline, streamKey: pipeline.streamKey, stream: pipeline.stream, participant, participantKey: energyKey },
    multiplier: participant.muted ? 0 : Math.max(0, Number(participant.value) || 0)
  }
}
