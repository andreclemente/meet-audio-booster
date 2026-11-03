import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Execute the actual packaged boot with the document not yet available. This
// validates hook timing, not a real browser or a native WebRTC implementation.
test('packaged ownership hooks precede DOM-delayed controller startup and negotiation', async () => {
  class Peer {
    getReceivers() { return [] }
    setRemoteDescription(value) { this.received = value; return Promise.resolve() }
  }
  class Track { clone() { return new Track() } }
  const originalDescription = Peer.prototype.setRemoteDescription
  const originalClone = Track.prototype.clone
  const timers = []
  const scope = {
    RTCPeerConnection: Peer, MediaStreamTrack: Track,
    location: { hostname: 'meet.google.com' }, document: { documentElement: null },
    performance: { now: () => 0 }, localStorage: { getItem: () => null },
    setTimeout(fn, ms) { timers.push({ fn, ms }) }, clearTimeout() {}
  }
  const bundle = await readFile(new URL('../dist/audio-booster.js', import.meta.url), 'utf8')
  vm.runInNewContext(bundle, scope)
  assert.equal(scope.__meetingAudioBoosterInstalled, true)
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 100)
  assert.notEqual(Peer.prototype.setRemoteDescription, originalDescription)
  assert.notEqual(Track.prototype.clone, originalClone)
  const peer = new Peer()
  const opaqueDescription = new Proxy({}, { get() { throw new Error('must not read signaling contents') } })
  await peer.setRemoteDescription(opaqueDescription)
  assert.equal(peer.received, opaqueDescription)
  assert.ok(new Track().clone() instanceof Track)
})
