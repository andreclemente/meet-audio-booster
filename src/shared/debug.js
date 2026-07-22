export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (item instanceof Map) return Object.fromEntries(item)
    if (item instanceof Set) return [...item]
    if (typeof item === 'function' || typeof item === 'symbol') return undefined
    return item
  }))
}

export function createDebugInfo(state, visibleParticipants) {
  const participants = visibleParticipants().map(participant => ({
    key: participant.key,
    name: participant.name,
    isSelf: Boolean(participant.isSelf),
    isSpeakingByUi: Boolean(participant.speaking),
    configuredMultiplier: Number.isFinite(participant.value) ? participant.value : 1,
    muted: Boolean(participant.muted || participant.value === 0)
  }))
  const slots = state.google.slots.map(slot => ({
    id: slot.id, baseGain: slot.baseGain, appliedMultiplier: slot.appliedMultiplier,
    targetValue: slot.targetValue, actualValue: Number(slot.gain?.gain?.value), participantKey: null
  }))
  const mediaPipelines = state.google.mediaPipelines.map(pipeline => {
    const track = pipeline.tracks?.[0]
    return {
      id: pipeline.id,
      streamId: pipeline.stream?.id || null,
      trackId: track?.id || null,
      connected: Boolean(pipeline.connected),
      muted: Boolean(track?.muted),
      readyState: track?.readyState || null,
      rms: Number(pipeline.rms) || 0,
      activeByEnergy: Boolean(pipeline.activeByEnergy),
      appliedMultiplier: Number.isFinite(pipeline.appliedMultiplier) ? pipeline.appliedMultiplier : 1,
      targetValue: Number.isFinite(pipeline.targetValue) ? pipeline.targetValue : 1,
      actualValue: Number.isFinite(Number(pipeline.gain?.gain?.value)) ? Number(pipeline.gain.gain.value) : null,
      participantKey: pipeline.participantKey || null,
      associationReliable: Boolean(pipeline.associationReliable),
      tracks: (pipeline.tracks || []).map(item => ({ id: item.id, muted: item.muted, enabled: item.enabled, readyState: item.readyState }))
    }
  })
  return jsonSafe({
    platform: state.platform,
    status: state.status,
    participantCount: participants.length,
    participants,
    activeParticipantKey: state.google.activeParticipantKey,
    appliedParticipantKey: state.google.appliedParticipantKey,
    routingState: state.google.routingState,
    transitionGuard: state.google.transitionGuard,
    slots,
    mediaPipelines,
    google: {
      mode: state.google.mode,
      routingState: state.google.routingState,
      activeParticipantKey: state.google.activeParticipantKey,
      appliedParticipantKey: state.google.appliedParticipantKey,
      transitionGuard: state.google.transitionGuard,
      slots,
      mediaPipelines
    }
  })
}

export function installDebugApi(state, visibleParticipants) {
  globalThis.__meetingAudioBoosterDebug = () => createDebugInfo(state, visibleParticipants)
}
