import test from 'node:test'
import assert from 'node:assert/strict'
import { collectCurrentUiSpeakers, createGoogleMeetController, createWorkletSpeakerTracker } from '../src/platforms/google-meet/index.js'

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
  const tracker = createWorkletSpeakerTracker({ releaseHoldMs: 180 })
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

test('a different visible speaker neutralizes a held gain immediately', () => {
  const tracker = createWorkletSpeakerTracker({ releaseHoldMs: 180 })
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
  const tracker = createWorkletSpeakerTracker({ releaseHoldMs: 180 })
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
