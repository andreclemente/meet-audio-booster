import test from 'node:test'
import assert from 'node:assert/strict'
import { scanMeetParticipants, isSelfParticipant } from '../src/platforms/google-meet/participants.js'
import { createGoogleMeetController } from '../src/platforms/google-meet/index.js'
import { createState } from '../src/state.js'

// Reconstructed from redacted meet-self-controls-v2 STRUCTURE, not captured HTML.
// Names, IDs, labels and DOM wrappers are synthetic. Icons/disabled flags follow
// the user's selected-self and remote groups. Real-DOM coverage lives in evidence.
const BUTTONS = 'button, [role="button"]'
function tile(id, { name = '同名', icons = [], labels = [], rich = false, requested = true, disabled = false } = {}) {
  const root = {
    innerText: name + (rich ? ' '.repeat(400) : ''), textContent: name,
    getAttribute(attr) {
      return attr === 'data-participant-id' ? id : attr === 'data-requested-participant-id' && requested ? id : null
    },
    matches() { return false }, querySelector() { return null },
    querySelectorAll(selector) {
      if (selector === BUTTONS) return buttons
      if (selector === '[aria-label]') return labelNodes
      if (selector.includes('data-self-name')) return name ? [nameNode] : []
      if (selector === '*') return [nameNode, ...buttons, ...labelNodes]
      return []
    }
  }
  const nameNode = {
    textContent: name, children: [],
    matches: selector => selector.includes('data-self-name'),
    getAttribute: attr => attr === 'data-self-name' ? name : null
  }
  const buttons = icons.map((text, index) => {
    const button = {
      disabled: disabled || index === 0, getAttribute() { return null },
      closest: selector => selector === '[data-participant-id]' ? root : button,
      querySelectorAll: selector => selector.includes('i') && selector.includes('span') ? [icon] : []
    }
    const icon = {
      textContent: text,
      closest: selector => selector === '[data-participant-id]' ? root : button
    }
    return button
  })
  const labelNodes = labels.map(label => ({
    getAttribute: () => label, closest: () => root
  }))
  root.buttons = buttons
  return root
}
const self = options => tile('self', { icons: ['frame_person', 'visual_effects', 'more_vert'], ...options })
const remote = options => tile('remote', { icons: ['keep_outline', 'mic_off', 'more_vert'], disabled: true, ...options })
const doc = roots => ({ hidden: false, querySelectorAll: selector => selector === '[data-participant-id]' ? roots : [] })
const ids = (roots, known) => scanMeetParticipants(doc(roots), known).map(item => item.participantId)

for (const name of ['同名', 'Pessoa A', 'أحمد']) {
  test(`own disabled control pair excludes self without translated labels: ${name}`, () => {
    assert.deepEqual(ids([self({ name }), remote({ name })]), ['remote'])
  })
}
for (const reverse of [false, true]) {
  test(`self evidence survives richest-root deduplication, reversed=${reverse}`, () => {
    const roots = [self(), tile('self', { rich: true, icons: ['more_vert'] })]
    if (reverse) roots.reverse()
    assert.deepEqual(ids([...roots, remote()]), ['remote'])
  })
}
test('unnamed own-control root contributes identity before name/root selection', () => {
  assert.deepEqual(ids([self({ name: '', requested: false }), tile('self', { rich: true }), remote()]), ['remote'])
})
test('People ordering is not identity: remote first stays, self row not first is excluded', () => {
  assert.deepEqual(ids([remote(), tile('self', { rich: true }), self()]), ['remote'])
})
test('each icon alone and disabled remote controls are insufficient', () => {
  for (const icons of [['frame_person'], ['visual_effects'], ['keep_outline', 'mic_off', 'more_vert'], ['frame_person_extra', 'visual_effects']]) {
    assert.deepEqual(ids([tile('remote', { icons, disabled: true })]), ['remote'])
  }
})
test('plain name or parent label containing icon tokens is not a button icon', () => {
  assert.equal(isSelfParticipant(tile('remote', { name: 'frame_person visual_effects', labels: ['frame_person visual_effects'] })), false)
})
test('icons owned by a nested different participant do not identify the outer root', () => {
  const outer = remote()
  const nested = self()
  const original = outer.querySelectorAll
  outer.querySelectorAll = selector => selector === BUTTONS ? nested.buttons : original(selector)
  assert.equal(isSelfParticipant(outer), false)
  assert.deepEqual(ids([outer, nested]), ['remote'])
})
test('the control pair must belong to one root, not be assembled across same-ID roots', () => {
  assert.deepEqual(ids([tile('remote', { icons: ['frame_person'] }), tile('remote', { icons: ['visual_effects'] })]), ['remote'])
})
test('nested English control labels are not borrowed by an outer participant', () => {
  const root = remote()
  const nested = tile('self')
  const original = root.querySelectorAll
  root.querySelectorAll = selector => selector === '[aria-label]'
    ? [{ getAttribute: () => 'Reframe', closest: () => nested }] : original(selector)
  assert.equal(isSelfParticipant(root), false)
})
test('generic raw-presentation flag/data-self-name are not new self markers', () => {
  const root = remote({ icons: [] })
  const original = root.getAttribute
  root.getAttribute = attr => attr === 'data-use-raw-local-presentation-stream' ? 'true' : original(attr)
  assert.deepEqual(ids([root]), ['remote'])
})
test('existing English controls aggregate across duplicate roots without matching remote helper text', () => {
  assert.deepEqual(ids([
    tile('self', { labels: ['Reframe'] }), tile('self', { rich: true }),
    remote({ labels: ["You can’t unmute someone else"] })
  ]), ['remote'])
})
test('scan-local evidence persists only in the explicitly supplied lifetime Set', () => {
  const known = new Set()
  assert.deepEqual(ids([self(), remote()], known), ['remote'])
  assert.deepEqual(ids([tile('self'), remote()], known), ['remote'])
  assert.deepEqual(ids([tile('self'), remote()], new Set()), ['self', 'remote'])
  assert.deepEqual(ids([tile('self'), remote()]), ['self', 'remote'])
})

function withController(run) {
  const originals = Object.fromEntries(['document', 'MutationObserver', 'setInterval', 'clearInterval'].map(key => [key, globalThis[key]]))
  let roots = []
  const ticks = new Map()
  globalThis.document = { ...doc(roots), addEventListener() {}, removeEventListener() {}, documentElement: {} }
  globalThis.document.querySelectorAll = selector => selector === '[data-participant-id]' ? roots : []
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.setInterval = (fn, ms) => { ticks.set(ms, fn); return ms }
  globalThis.clearInterval = ms => ticks.delete(ms)
  const state = createState({ getItem() { return null } })
  state.google.mode = 'worklet'
  const writes = []
  const make = () => createGoogleMeetController({ state, context: {}, setStatus() {}, renderSoon() {}, updateLiveUi() {} })
  let controller = make()
  const slot = () => ({ set(value) { writes.push(value) }, destroy() {}, release() {} })
  try {
    run({ state, writes, make, slot, get controller() { return controller }, replace(value) { controller = value },
      roots(value) { roots = value }, tick() { ticks.get(750)() } })
  } finally {
    controller.stop()
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
}
test('discovering self does not clear an unrelated confirmed remote or its missing-roster grace', () => {
  withController(h => {
    const remoteRoot = remote()
    remoteRoot.matches = () => true
    h.roots([tile('self'), remoteRoot]); h.controller.start()
    h.state.google.slots.push(h.slot())
    const originalNow = Date.now
    let now = Date.now()
    Date.now = () => now
    try {
      h.state.participants.get('id:remote').value = 2
      h.controller.route(); now += 60; h.controller.route()
      assert.equal(h.state.google.appliedParticipantKey, 'id:remote')
      remoteRoot.matches = () => false
      h.roots([self(), remoteRoot]); h.tick(); h.controller.route()
      assert.equal(h.state.google.appliedParticipantKey, 'id:remote')
      assert.equal(h.writes.at(-1), 2)
      h.roots([self()]); h.tick()
      assert.equal(h.state.participants.get('id:remote').present, true)
      now += 8001; h.tick()
      assert.equal(h.state.participants.get('id:remote').present, false)
    } finally { Date.now = originalNow }
  })
})
test('discovering self invalidates only self media routing and writes neutral pipeline output', () => {
  withController(h => {
    h.roots([tile('self'), remote()]); h.controller.start()
    h.state.google.mode = 'media'
    h.state.google.activeParticipantKey = 'id:self'
    h.state.google.appliedParticipantKey = 'id:self'
    h.state.google.routing = {
      routingState: 'confirmed-speaker', appliedParticipantKey: 'id:self',
      lastConfirmedParticipantKey: 'id:self', appliedPipelineId: 'self-pipe', multiplier: 4.5
    }
    const values = []
    h.controller.pipelines.push({
      id: 'self-pipe', participantKey: 'id:self', associationReliable: true,
      elements: new Set(), set(value) { values.push(value) }, destroy() {}
    })
    h.roots([self(), remote()]); h.tick()
    assert.equal(h.state.participants.get('id:self').present, false)
    assert.equal(h.state.google.appliedParticipantKey, null)
    assert.equal(h.state.google.routing.lastConfirmedParticipantKey, null)
    assert.deepEqual(values, [1])
  })
})

test('controller promptly removes discovered self, clears held worklet gain, and scopes identity to lifetime', () => {
  withController(h => {
    const row = tile('self')
    h.roots([row, remote()])
    h.controller.start()
    const participant = h.state.participants.get('id:self')
    participant.value = 4.5
    // Confirm the previously misclassified self in the actual worklet tracker.
    row.matches = () => true
    const originalNow = Date.now
    let now = 1000
    Date.now = () => now
    h.state.google.slots.push(h.slot())
    try {
      h.controller.route(); now += 60; h.controller.route()
      assert.equal(h.state.google.appliedParticipantKey, 'id:self')
      row.matches = () => false
      h.roots([self(), row, remote()]); h.tick()
      assert.equal(participant.present, false, 'self must bypass the 8-second missing-roster grace')
      h.controller.route()
      assert.equal(h.state.google.appliedParticipantKey, null)
      assert.equal(h.writes.at(-1), 1, 'silence must not retain a known-self gain')
      h.roots([row, remote()]); h.tick()
      assert.equal(participant.present, false)
      h.controller.stop(); h.controller.start()
      assert.equal(participant.present, true, 'stop clears the same controller lifetime cache')
      h.roots([self(), row, remote()]); h.tick()
      assert.equal(participant.present, false)
      h.controller.stop(); h.roots([row, remote()]); h.replace(h.make()); h.controller.start()
      assert.equal(participant.present, true, 'a new controller does not inherit known IDs')
    } finally { Date.now = originalNow }
  })
})
