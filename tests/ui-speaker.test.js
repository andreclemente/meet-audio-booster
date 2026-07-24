import test from 'node:test'
import assert from 'node:assert/strict'
import { collectCurrentUiSpeakers, collectCurrentUiSpeakersAcrossRoots, createGoogleMeetController, createWorkletSpeakerTracker, resolveLocalPresentationActive } from '../src/platforms/google-meet/index.js'

function fakeParticipantRoot(participantId, speaking = false) {
  return {
    getAttribute(name) { return name === 'data-participant-id' ? participantId : null },
    matches(selector) { return selector === '.BlxGDf' && speaking },
    querySelector() { return null },
    querySelectorAll() { return [] }
  }
}

test('speaker detection uses a speaking tile sibling when the selected roster root is quiet', () => {
  const tile = fakeParticipantRoot('device-a', true)
  const roster = fakeParticipantRoot('device-a', false)
  const root = { querySelectorAll: selector => selector === '[data-participant-id]' ? [tile, roster] : [] }
  const alice = { key: 'A', participantId: 'device-a', element: roster, speaking: false, lastSpeakingAt: 0 }

  const result = collectCurrentUiSpeakersAcrossRoots([alice], root)

  assert.deepEqual(result.map(participant => participant.key), ['A'])
  assert.equal(alice.speaking, true)
})

test('previous UI speaker is not held after the speaking marker clears', () => {
  const participants = [
    { key: 'A', speaking: true, lastSpeakingAt: 900 },
    { key: 'B', speaking: false, lastSpeakingAt: 0 }
  ]
  const speakingRoots = new Set(['B'])
  const result = collectCurrentUiSpeakers(participants, participant => speakingRoots.has(participant.key))
  assert.deepEqual(result.map(participant => participant.key), ['B'])
  assert.equal(participants[0].speaking, false)
  assert.equal(participants[1].speaking, true)
})

test('brief speaking-marker gaps do not pulse a confirmed participant gain', () => {
  const tracker = createWorkletSpeakerTracker()
  const alice = { key: 'A', name: 'Alice', value: 4.5 }

  assert.equal(tracker.update({ now: 0, speakers: [alice], hidden: false }).routingState, 'transitioning')
  assert.equal(tracker.update({ now: 60, speakers: [alice], hidden: false }).multiplier, 4.5)

  const gap = tracker.update({ now: 120, speakers: [], hidden: false })
  assert.equal(gap.routingState, 'confirmed-speaker')
  assert.equal(gap.appliedParticipantKey, 'A')
  assert.equal(gap.multiplier, 4.5)

  const resumed = tracker.update({ now: 180, speakers: [alice], hidden: false })
  assert.equal(resumed.routingState, 'confirmed-speaker')
  assert.equal(resumed.multiplier, 4.5)
})

test('default tracker tolerates the observed half-second Meet marker dropout', () => {
  const tracker = createWorkletSpeakerTracker()
  const alice = { key: 'A', name: 'Alice', value: 4.5 }

  tracker.update({ now: 0, speakers: [alice], hidden: false })
  tracker.update({ now: 60, speakers: [alice], hidden: false })
  tracker.update({ now: 120, speakers: [], hidden: false })

  const gap = tracker.update({ now: 620, speakers: [], hidden: false })
  assert.equal(gap.routingState, 'confirmed-speaker')
  assert.equal(gap.appliedParticipantKey, 'A')
  assert.equal(gap.multiplier, 4.5)
})

test('confirmed boost remains latched without a speaking-marker timeout', () => {
  const tracker = createWorkletSpeakerTracker()
  const alice = { key: 'A', name: 'Alice', value: 4.5 }

  tracker.update({ now: 0, speakers: [alice], hidden: false })
  tracker.update({ now: 60, speakers: [alice], hidden: false })
  tracker.update({ now: 120, speakers: [], hidden: false })

  const longGap = tracker.update({ now: 30060, speakers: [], hidden: false })
  assert.equal(longGap.routingState, 'confirmed-speaker')
  assert.equal(longGap.appliedParticipantKey, 'A')
  assert.equal(longGap.multiplier, 4.5)
})

test('a different visible speaker neutralizes a held gain immediately', () => {
  const tracker = createWorkletSpeakerTracker()
  const alice = { key: 'A', name: 'Alice', value: 4.5 }
  const bob = { key: 'B', name: 'Bob', value: 1 }

  tracker.update({ now: 0, speakers: [alice], hidden: false })
  tracker.update({ now: 60, speakers: [alice], hidden: false })
  tracker.update({ now: 120, speakers: [], hidden: false })

  const changed = tracker.update({ now: 130, speakers: [bob], hidden: false })
  assert.equal(changed.routingState, 'transitioning')
  assert.equal(changed.appliedParticipantKey, null)
  assert.equal(changed.multiplier, 1)
})

test('hiding the Meet tab neutralizes and clears a confirmed worklet gain', () => {
  const tracker = createWorkletSpeakerTracker()
  const alice = { key: 'A', name: 'Alice', value: 4.5 }

  tracker.update({ now: 0, speakers: [alice], hidden: false })
  tracker.update({ now: 60, speakers: [alice], hidden: false })

  const hidden = tracker.update({ now: 70, speakers: [alice], hidden: true })
  assert.equal(hidden.routingState, 'hidden-tab')
  assert.equal(hidden.appliedParticipantKey, null)
  assert.equal(hidden.multiplier, 1)

  const visibleAgain = tracker.update({ now: 1000, speakers: [alice], hidden: false })
  assert.equal(visibleAgain.routingState, 'transitioning')
  assert.equal(visibleAgain.multiplier, 1)
})

test('hidden Meet tab keeps media pipelines neutral across routing ticks', () => {
  const originalDocument = globalThis.document
  globalThis.document = { hidden: true }
  try {
    const participant = {
      key: 'A', platform: 'google-meet', name: 'Alice', present: true,
      speaking: false, lastSpeakingAt: 0, value: 4.5, muted: false, element: null
    }
    const state = {
      participants: new Map([['A', participant]]),
      google: {
        slots: [], mediaPipelines: [], mode: 'media', activeParticipantKey: 'A',
        appliedParticipantKey: 'A', routingState: 'confirmed-speaker',
        transitionGuard: { candidateParticipantKey: null, candidateSince: 0 },
        routing: {
          routingState: 'confirmed-speaker', appliedParticipantKey: 'A', appliedPipelineId: 'pipe-a',
          lastConfirmedParticipantKey: 'A', candidateParticipantKey: null, candidateSince: 0, multiplier: 4.5
        },
        rosterSignature: '', localPresentationActive: false
      }
    }
    const controller = createGoogleMeetController({
      state, context: {}, setStatus() {}, renderSoon() {}, updateLiveUi() {}
    })
    const writes = []
    controller.pipelines.push({
      id: 'pipe-a', participantKey: 'A', associationReliable: true, activeByEnergy: true,
      sample() { return this },
      set(value) { writes.push(value); this.appliedMultiplier = value }
    })

    controller.route()

    assert.equal(state.google.routingState, 'hidden-tab')
    assert.equal(state.google.appliedParticipantKey, null)
    assert.equal(state.google.routing.multiplier, 1)
    assert.deepEqual(writes, [1])
  } finally {
    globalThis.document = originalDocument
  }
})

test('completed capture lifecycle overrides a stale presentation DOM root', () => {
  assert.equal(resolveLocalPresentationActive({ captureActive: true, domActive: false, captureLifecycleSeen: true }), true)
  assert.equal(resolveLocalPresentationActive({ captureActive: false, domActive: true, captureLifecycleSeen: true }), false)
  assert.equal(resolveLocalPresentationActive({ captureActive: false, domActive: true, captureLifecycleSeen: false }), true)
})

test('local presentation does not force worklet participant boost to 100 percent', () => {
  const originalDocument = globalThis.document
  const originalNow = Date.now
  const speakingRoot = fakeParticipantRoot('device-a', true)
  globalThis.document = {
    hidden: false,
    querySelectorAll(selector) { return selector === '[data-participant-id]' ? [speakingRoot] : [] }
  }
  let now = 0
  Date.now = () => now
  try {
    const alice = {
      key: 'A', platform: 'google-meet', participantId: 'device-a', name: 'Alice', present: true,
      speaking: false, lastSpeakingAt: 0, value: 4.5, muted: false, element: speakingRoot
    }
    const writes = []
    const slot = {
      gain: {}, appliedMultiplier: 1,
      set(value) { writes.push(value); this.appliedMultiplier = value },
      release() { writes.push(1); this.appliedMultiplier = 1 }
    }
    const state = {
      participants: new Map([['A', alice]]),
      google: {
        slots: [slot], mediaPipelines: [], mode: 'worklet', activeParticipantKey: null,
        appliedParticipantKey: null, routingState: 'idle',
        transitionGuard: { candidateParticipantKey: null, candidateSince: 0 },
        routing: {}, rosterSignature: '', localPresentationActive: true
      }
    }
    const controller = createGoogleMeetController({
      state, context: {}, setStatus() {}, renderSoon() {}, updateLiveUi() {}
    })

    controller.route()
    now = 60
    controller.route()

    assert.equal(state.google.routingState, 'confirmed-speaker')
    assert.equal(state.google.appliedParticipantKey, 'A')
    assert.equal(slot.appliedMultiplier, 4.5)
    assert.equal(writes.at(-1), 4.5)
  } finally {
    Date.now = originalNow
    globalThis.document = originalDocument
  }
})
