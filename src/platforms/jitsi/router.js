import { writeAudioParam } from '../../shared/audio.js'

export function routeJitsiParticipant(participant, multiplier) {
  const value = Number.isFinite(multiplier) ? Math.max(0, multiplier) : 1
  if (participant.clonedTrack) participant.clonedTrack.enabled = value > 0
  if (participant.gain?.gain) writeAudioParam(participant.gain.gain, value)
  participant.value = value
  return participant
}
