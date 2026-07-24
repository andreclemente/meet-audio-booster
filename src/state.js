import { loadSettings, getParticipantGain } from './storage.js'
import { createRoutingState } from './platforms/google-meet/router.js'

export function createState(storage = globalThis.localStorage) {
  return {
    platform: null,
    participants: new Map(),
    settings: loadSettings(storage),
    status: 'Starting…',
    audioUnavailable: false,
    closed: false,
    panel: null,
    renderTimer: null,
    sharedCtx: null,
    google: {
      mode: 'detecting', modeStartedAt: performance.now(), slots: [], mediaPipelines: [],
      activeParticipantKey: null, appliedParticipantKey: null, routingState: 'idle',
      transitionGuard: { candidateParticipantKey: null, candidateSince: 0 },
      routing: createRoutingState(), rosterSignature: '', localPresentationActive: false
    },
    jitsi: { pipelines: [], keepAliveTimer: null }
  }
}

export function upsertParticipant(state, data) {
  const existing = state.participants.get(data.key)
  if (existing) {
    existing.name = data.name || existing.name
    existing.present = data.present ?? existing.present
    existing.speaking = data.speaking ?? existing.speaking
    existing.lastSeenAt = data.lastSeenAt ?? Date.now()
    if (data.speaking) existing.lastSpeakingAt = Date.now()
    Object.assign(existing, data.extra || {})
    return existing
  }
  const participant = {
    key: data.key, platform: data.platform, name: data.name,
    present: data.present ?? true, speaking: Boolean(data.speaking),
    lastSeenAt: data.lastSeenAt ?? Date.now(), lastSpeakingAt: data.speaking ? Date.now() : 0,
    ...data.extra
  }
  participant.value = getParticipantGain(state.settings, participant)
  state.participants.set(participant.key, participant)
  return participant
}

export function visibleParticipants(state, platform = state.platform) {
  return [...state.participants.values()]
    .filter(participant => participant.platform === platform && participant.present !== false)
    .sort((a, b) => a.name.localeCompare(b.name))
}
