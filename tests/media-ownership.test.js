import test from 'node:test'
import assert from 'node:assert/strict'
import { installRemoteMediaOwnership } from '../src/platforms/google-meet/media-ownership.js'

function fixture(t) {
  class Track {
    constructor(id) { this.id = id; this.kind = 'audio'; this.readyState = 'live' }
    clone() { return new Track(this.id + '-clone') }
    stop() { this.readyState = 'ended' }
  }
  class Peer {
    connectionState = 'connected'
    signalingState = 'stable'
    receivers = []
    getReceivers() { return this.receivers }
    setRemoteDescription(...args) { this.args = args; return Promise.resolve() }
  }
  const scope = { RTCPeerConnection: Peer, MediaStreamTrack: Track }
  const originals = [Peer.prototype.setRemoteDescription, Track.prototype.clone]
  const ownership = installRemoteMediaOwnership(scope)
  t.after(() => ownership.dispose())
  const stream = (...tracks) => ({ getAudioTracks: () => tracks })
  return { Track, Peer, ownership, stream, originals }
}

test('native receivers affirm remote ownership; unknown, local and mixed sources stay native', async t => {
  const { Track, Peer, ownership, stream } = fixture(t)
  const peer = new Peer(), remote = new Track('same'), local = new Track('same')
  peer.receivers = [{ track: remote }]
  await peer.setRemoteDescription({ type: 'answer' })
  ownership.refresh()
  assert.equal(ownership.accepts(stream(remote)), true)
  assert.equal(ownership.accepts(stream(local)), false, 'matching ids are not provenance')
  assert.equal(ownership.accepts(stream(remote, local)), false)
  assert.equal(ownership.accepts(stream()), false)
  assert.equal(ownership.accepts(stream(local.clone())), false)
})

test('clone lineage survives cloning before discovery, stream reconstruction and multiple generations', async t => {
  const { Track, Peer, ownership, stream } = fixture(t)
  const track = new Track('remote'), clone = track.clone().clone()
  const peer = new Peer()
  peer.receivers = [{ track }]
  assert.equal(ownership.accepts(stream(clone)), false)
  await peer.setRemoteDescription()
  ownership.refresh()
  assert.equal(ownership.accepts(stream(clone)), true)
  clone.stop()
  assert.equal(ownership.accepts(stream(clone)), false)
})

test('receiver replacement, closure and reconnect invalidate old lineage, not new remote audio', async t => {
  const { Track, Peer, ownership, stream } = fixture(t)
  const peer = new Peer(), first = new Track('reused'), next = new Track('reused')
  peer.receivers = [{ track: first }]
  await peer.setRemoteDescription(); ownership.refresh()
  const clone = first.clone()
  assert.equal(ownership.accepts(stream(clone)), true)
  peer.receivers = [{ track: next }]
  ownership.refresh()
  assert.equal(ownership.accepts(stream(clone)), false)
  assert.equal(ownership.accepts(stream(next)), true)
  peer.connectionState = 'closed'
  assert.equal(ownership.accepts(stream(next)), false)
  ownership.refresh()
  const reconnected = new Peer(), fresh = new Track('reused')
  reconnected.receivers = [{ track: fresh }]
  await reconnected.setRemoteDescription(); ownership.refresh()
  assert.equal(ownership.accepts(stream(fresh)), true)
})

test('cleanup restores methods, does not stop tracks and revokes retained ownership', async t => {
  const { Track, Peer, ownership, stream, originals } = fixture(t)
  const peer = new Peer(), track = new Track('remote')
  peer.receivers = [{ track }]
  await peer.setRemoteDescription(); ownership.refresh()
  ownership.dispose()
  assert.equal(Peer.prototype.setRemoteDescription, originals[0])
  assert.equal(Track.prototype.clone, originals[1])
  assert.equal(track.readyState, 'live')
  assert.equal(ownership.accepts(stream(track)), false)
})

test('ending the receiver root revokes a still-live clone', async t => {
  const { Track, Peer, ownership, stream } = fixture(t)
  const peer = new Peer(), track = new Track('remote')
  peer.receivers = [{ track }]
  await peer.setRemoteDescription(); ownership.refresh()
  const clone = track.clone()
  assert.equal(ownership.accepts(stream(clone)), true)
  track.stop()
  assert.equal(clone.readyState, 'live')
  assert.equal(ownership.accepts(stream(clone)), false)
})

test('unsupported native metadata hooks conservatively accept nothing', () => {
  const ownership = installRemoteMediaOwnership({})
  ownership.refresh()
  assert.equal(ownership.accepts({ getAudioTracks: () => [{ kind: 'audio', readyState: 'live' }] }), false)
  ownership.dispose()
})
