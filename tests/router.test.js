import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoutingState, routeGoogleAudio } from '../src/platforms/google-meet/router.js'

const participants = {
  A: { key: 'A', value: 4.5, muted: false },
  B: { key: 'B', value: 1, muted: false }
}

function tick(state, overrides = {}, now = 1000) {
  return routeGoogleAudio(state, {
    now,
    participants,
    uiSpeakerKeys: ['A'],
    pipelines: [{ id: 'stream-a', activeByEnergy: true, participantKey: 'A', associationReliable: true }],
    ...overrides
  })
}

test('resets to unity when another stream starts before Meet changes speaker', () => {
  let state = tick(createRoutingState())
  assert.equal(state.multiplier, 4.5)
  state = tick(state, {
    pipelines: [
      { id: 'stream-a', activeByEnergy: true, participantKey: 'A', associationReliable: true },
      { id: 'stream-b', activeByEnergy: true, participantKey: null, associationReliable: false }
    ]
  }, 1030)
  assert.equal(state.multiplier, 1)
  assert.equal(state.appliedParticipantKey, null)
  assert.equal(state.routingState, 'multiple-active-streams')
})

test('speaker handoff always passes through neutral before B gain', () => {
  let state = tick(createRoutingState())
  state = tick(state, {
    uiSpeakerKeys: ['B'],
    pipelines: [{ id: 'stream-b', activeByEnergy: true, participantKey: 'B', associationReliable: true }]
  }, 1030)
  assert.equal(state.multiplier, 1)
  assert.equal(state.routingState, 'transitioning')
  state = tick(state, {
    uiSpeakerKeys: ['B'],
    pipelines: [{ id: 'stream-b', activeByEnergy: true, participantKey: 'B', associationReliable: true }]
  }, 1100)
  assert.equal(state.multiplier, 1)
  assert.equal(state.appliedParticipantKey, 'B')
  assert.equal(state.routingState, 'confirmed-speaker')
})

test('ambiguous, stale, and unassociated observations use unity', () => {
  let state = tick(createRoutingState())
  for (const observation of [
    { uiSpeakerKeys: ['A', 'B'], pipelines: [{ id: 'a', activeByEnergy: true }, { id: 'b', activeByEnergy: true }] },
    { uiSpeakerKeys: [], pipelines: [{ id: 'a', activeByEnergy: true, participantKey: null, associationReliable: false }] },
    { uiSpeakerKeys: ['A'], pipelines: [{ id: 'stream-b', activeByEnergy: true, participantKey: 'B', associationReliable: true }] }
  ]) {
    state = tick(state, observation, 1200)
    assert.equal(state.multiplier, 1)
    assert.equal(state.appliedParticipantKey, null)
  }
})

test('mute never leaks from A to B during handoff', () => {
  const mutedParticipants = { ...participants, A: { ...participants.A, value: 0, muted: true } }
  let state = routeGoogleAudio(createRoutingState(), {
    now: 1000, participants: mutedParticipants, uiSpeakerKeys: ['A'],
    pipelines: [{ id: 'a', activeByEnergy: true, participantKey: 'A', associationReliable: true }]
  })
  assert.equal(state.multiplier, 0)
  state = routeGoogleAudio(state, {
    now: 1030, participants: mutedParticipants, uiSpeakerKeys: ['B'],
    pipelines: [{ id: 'b', activeByEnergy: true, participantKey: 'B', associationReliable: true }]
  })
  assert.equal(state.multiplier, 1)
  assert.equal(state.appliedParticipantKey, null)
})

test('a reliably associated quiet stream can route before delayed UI updates', () => {
  const state = routeGoogleAudio(createRoutingState(), {
    now: 1000, participants, uiSpeakerKeys: [],
    pipelines: [{ id: 'a', activeByEnergy: true, participantKey: 'A', associationReliable: true }]
  })
  assert.equal(state.multiplier, 4.5)
  assert.equal(state.appliedParticipantKey, 'A')
})

test('confirmed A through silence still transitions before reliable B gain', () => {
  let state = tick(createRoutingState())
  state = tick(state, { uiSpeakerKeys: [], pipelines: [] }, 1030)
  assert.equal(state.multiplier, 1)
  state = tick(state, {
    uiSpeakerKeys: ['B'],
    pipelines: [{ id: 'stream-b', activeByEnergy: true, participantKey: 'B', associationReliable: true }]
  }, 1100)
  assert.equal(state.routingState, 'transitioning')
  assert.equal(state.multiplier, 1)
  state = tick(state, {
    uiSpeakerKeys: ['B'],
    pipelines: [{ id: 'stream-b', activeByEnergy: true, participantKey: 'B', associationReliable: true }]
  }, 1160)
  assert.equal(state.appliedParticipantKey, 'B')
  assert.equal(state.multiplier, 1)
})
