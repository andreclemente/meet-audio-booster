export function getJitsiParticipantId(streams = []) {
  const id = streams.map(stream => stream.id).find(value => value.includes('-audio-'))
  return id?.split('-audio-')[0] || null
}

export function isJitsiRemoteAudio(track, streams = []) {
  if (track?.kind !== 'audio' || track.id === 'remote-audio-1') return false
  const ids = streams.map(stream => stream.id)
  return !ids.includes('mixedmslabel') && !ids.includes('remote-audio-1') && ids.some(id => id.includes('-audio-'))
}

export function getJitsiName(participantId, fallback = 'Remote participant') {
  if (!participantId) return fallback
  try {
    const room = globalThis.APP?.conference?._room
    const participant = room?.getParticipantById?.(participantId) || room?.participants?.[participantId]
    return participant?.getDisplayName?.() || participant?._displayName || participant?.displayName || participant?._identity?.user?.name || fallback
  } catch { return fallback }
}
