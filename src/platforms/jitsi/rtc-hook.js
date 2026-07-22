export function installRtcHook(onTrack) {
  const Original = globalThis.RTCPeerConnection
  if (!Original || globalThis.__meetingAudioBoosterRtcHook) return () => {}
  globalThis.__meetingAudioBoosterRtcHook = Original
  function Wrapped(...args) {
    const peer = new Original(...args)
    let handler = null
    peer.addEventListener('track', event => {
      onTrack(event)
      if (typeof handler === 'function') handler.call(peer, event)
    })
    Object.defineProperty(peer, 'ontrack', {
      configurable: true, enumerable: true,
      get: () => handler,
      set: value => { handler = value }
    })
    return peer
  }
  Wrapped.prototype = Original.prototype
  Object.setPrototypeOf(Wrapped, Original)
  globalThis.RTCPeerConnection = Wrapped
  return () => {
    if (globalThis.RTCPeerConnection === Wrapped) globalThis.RTCPeerConnection = Original
    delete globalThis.__meetingAudioBoosterRtcHook
  }
}
