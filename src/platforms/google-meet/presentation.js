const HOOK_KEY = '__meetingAudioBoosterDisplayCaptureHook'

export function installLocalPresentationCaptureHook(onActive, mediaDevices = globalThis.navigator?.mediaDevices) {
  if (!mediaDevices) return () => {}
  const owner = Object.getPrototypeOf(mediaDevices) || mediaDevices
  const original = owner.getDisplayMedia
  if (typeof original !== 'function' || owner[HOOK_KEY]) return () => {}

  const captures = new Set()
  let active = false
  let disposed = false
  const emit = next => {
    if (disposed || active === next) return
    active = next
    onActive(next)
  }
  const removeCapture = capture => {
    if (!captures.delete(capture)) return
    for (const track of capture.tracks) track.removeEventListener?.('ended', capture.checkEnded)
    emit(captures.size > 0)
  }

  const wrapped = async function (...args) {
    const stream = await original.apply(this, args)
    if (disposed) return stream
    const allTracks = stream?.getTracks?.() || []
    const tracks = allTracks.length ? allTracks : (stream?.getVideoTracks?.() || [])
    if (!tracks.length || tracks.every(track => track.readyState === 'ended')) return stream
    const videoTracks = stream?.getVideoTracks?.() || []
    const capture = { tracks, videoTracks, checkEnded: null }
    capture.checkEnded = () => {
      const primaryTracks = videoTracks.length ? videoTracks : tracks
      if (primaryTracks.every(track => track.readyState === 'ended')) removeCapture(capture)
    }
    captures.add(capture)
    for (const track of tracks) track.addEventListener?.('ended', capture.checkEnded)
    emit(true)
    return stream
  }

  owner[HOOK_KEY] = wrapped
  owner.getDisplayMedia = wrapped

  return () => {
    if (disposed) return
    disposed = true
    for (const capture of captures) {
      for (const track of capture.tracks) track.removeEventListener?.('ended', capture.checkEnded)
    }
    captures.clear()
    if (owner.getDisplayMedia === wrapped) owner.getDisplayMedia = original
    if (owner[HOOK_KEY] === wrapped) delete owner[HOOK_KEY]
  }
}
