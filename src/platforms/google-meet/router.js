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
    multiplier: 1
  }
}

export function routeGoogleAudio(previous = createRoutingState(), observation = {}) {
  const now = observation.now ?? Date.now()
  const participants = observation.participants || {}
  const ui = [...new Set(observation.uiSpeakerKeys || [])]
  const active = (observation.pipelines || []).filter(pipeline => pipeline.activeByEnergy)

  if (active.length > 1) return neutral(previous, 'multiple-active-streams', null, now)
  if (ui.length > 1) return neutral(previous, 'ambiguous', null, now)
  if (!active.length) return neutral(previous, ui.length ? 'stale-ui-speaker' : 'idle', null, now)

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
    multiplier: participant.muted ? 0 : Math.max(0, Number(participant.value) || 0)
  }
}
