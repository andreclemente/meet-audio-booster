import test from 'node:test'
import assert from 'node:assert/strict'
import { createRowAdmission, ROW_ADMISSION_MS } from '../src/platforms/google-meet/row-admission.js'
import { extractNameFromParticipantRoot } from '../src/shared/dom.js'
import { createState, upsertParticipant } from '../src/state.js'

test('a new row needs the same name across two scans at least ROW_ADMISSION_MS apart', () => {
  const rows = createRowAdmission()
  const scan = (now, entries) => { rows.begin(); const out = entries.filter(([key, name]) => rows.admit(key, name, now)).map(([key]) => key); rows.end(); return out }
  assert.deepEqual(scan(0, [['a', 'Ana']]), [])
  assert.deepEqual(scan(80, [['a', 'Ana']]), [], 'two quick mutation scans are not enough')
  assert.deepEqual(scan(ROW_ADMISSION_MS, [['a', 'Ana']]), ['a'])
  // A transient wrong name restarts admission.
  assert.deepEqual(scan(0, [['b', 'Receiver']]), [])
  assert.deepEqual(scan(500, [['b', 'Bea']]), [])
  assert.deepEqual(scan(1000, [['b', 'Bea']]), ['b'])
  // A candidate that vanishes for one scan starts over.
  assert.deepEqual(scan(0, [['c', 'Cai']]), [])
  assert.deepEqual(scan(300, []), [])
  assert.deepEqual(scan(800, [['c', 'Cai']]), [])
  assert.deepEqual(scan(1300, [['c', 'Cai']]), ['c'])
})

function el(attrs, { text = '', parentRoot = null, matches = () => false } = {}) {
  return { textContent: text, innerText: text, getAttribute: name => attrs[name] ?? null, matches, closest: () => parentRoot, children: [], querySelectorAll: () => [] }
}

test('a tile never borrows the name or labels of a nested tile', () => {
  const root = el({ 'data-participant-id': 'remote' })
  const nestedSelf = { nested: true }
  const selfLabel = el({ 'data-self-name': 'Receiver' }, { text: 'Receiver', parentRoot: nestedSelf, matches: selector => selector.includes('data-self-name') })
  const ownLabel = el({ 'data-self-name': 'Bea' }, { text: 'Bea', parentRoot: root, matches: selector => selector.includes('data-self-name') })
  root.querySelectorAll = selector => selector.includes('aria-label') ? [] : [selfLabel, ownLabel]
  assert.equal(extractNameFromParticipantRoot(root), 'Bea')
  root.querySelectorAll = selector => selector.includes('aria-label') ? [] : [selfLabel]
  assert.equal(extractNameFromParticipantRoot(root), null)
})

test('a rename restores the saved volume for the corrected name until anything changes it', () => {
  const state = createState({ getItem() { return null } })
  state.settings.gains = { 'google-meet:name:bea': 2 }
  const p = upsertParticipant(state, { key: 'id:new', platform: 'google-meet', name: 'Receiver' })
  assert.equal(p.value, 1)
  upsertParticipant(state, { key: 'id:new', platform: 'google-meet', name: 'Bea' })
  assert.equal(p.value, 2, 'value follows the corrected name')
  p.value = 0.5
  upsertParticipant(state, { key: 'id:new', platform: 'google-meet', name: 'Bea B' })
  assert.equal(p.value, 0.5, 'a changed volume is never overwritten by a rename')
})
