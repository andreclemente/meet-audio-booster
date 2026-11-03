// Native receiver identity is affirmative remote provenance, not a guess from
// labels, track ids or the absence of a known display-capture track. No SDP,
// packets, frames or signaling fields are read.
export function installRemoteMediaOwnership(scope = globalThis) {
  const peers = new Set()
  const parents = new WeakMap()
  const origins = new WeakMap()
  const restores = []
  let disposed = false
  const pcPrototype = scope.RTCPeerConnection?.prototype
  const trackPrototype = scope.MediaStreamTrack?.prototype
  const getReceivers = pcPrototype?.getReceivers
  function observe(peer) { if (!disposed) peers.add(peer) }
  function wrap(owner, name, factory) {
    if (!owner || typeof owner[name] !== 'function') return
    const original = owner[name]
    const wrapped = factory(original)
    try {
      owner[name] = wrapped
      if (owner[name] === wrapped) restores.push(() => { if (owner[name] === wrapped) owner[name] = original })
    } catch {}
  }
  // Observe the peer before the native method can dispatch track events. Also
  // catches pre-existing peers on their next negotiation without inspecting args.
  wrap(pcPrototype, 'setRemoteDescription', original => function (...args) {
    observe(this)
    return original.apply(this, args)
  })
  wrap(trackPrototype, 'clone', original => function (...args) {
    const clone = original.apply(this, args)
    if (!disposed) parents.set(clone, this)
    return clone
  })
  function refresh() {
    if (disposed || typeof getReceivers !== 'function') return
    for (const peer of peers) {
      if (peer.connectionState === 'closed' || peer.signalingState === 'closed') { peers.delete(peer); continue }
      try {
        for (const receiver of getReceivers.call(peer)) {
          if (receiver.track?.kind === 'audio') origins.set(receiver.track, peer)
        }
      } catch {}
    }
  }
  function remote(track) {
    if (disposed || track?.kind !== 'audio' || track.readyState !== 'live') return false
    const seen = new Set()
    for (let current = track; current && !seen.has(current); current = parents.get(current)) {
      if (current.readyState !== 'live') return false
      seen.add(current)
      const peer = origins.get(current)
      if (!peer || !peers.has(peer) || peer.connectionState === 'closed' || peer.signalingState === 'closed') continue
      try { if (getReceivers.call(peer).some(receiver => receiver.track === current)) return true } catch {}
    }
    return false
  }
  return {
    refresh,
    accepts(stream) {
      const tracks = stream?.getAudioTracks?.() || []
      return tracks.length > 0 && tracks.every(remote)
    },
    dispose() {
      disposed = true
      peers.clear()
      for (const restore of restores.reverse()) { try { restore() } catch {} }
    }
  }
}
