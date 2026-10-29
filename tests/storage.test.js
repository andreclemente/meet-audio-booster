import test from 'node:test'
import assert from 'node:assert/strict'
import { STORAGE_KEY, LEGACY_STORAGE_KEYS } from '../src/shared/constants.js'
import { loadSettings, saveSettings, participantStorageKeys, setParticipantGain } from '../src/storage.js'
import { createState } from '../src/state.js'

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries))
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
    dump: () => Object.fromEntries(values)
  }
}

test('preserves current v15 settings including mute and panel position', () => {
  const raw = { gains: { 'google-meet:name:alice': 0, 'jitsi:id:p1': 2.5 }, position: { left: 12, top: 34 } }
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(raw) })
  assert.deepEqual(loadSettings(storage), { ...raw, collapsed: false })
})

test('migrates older compatible settings without deleting them before save succeeds', () => {
  const raw = { gains: { 'google-meet:name:alice': 4.5 }, position: { left: 1, top: 2 } }
  const storage = memoryStorage({ [LEGACY_STORAGE_KEYS[0]]: JSON.stringify(raw) })
  assert.deepEqual(loadSettings(storage), { ...raw, collapsed: false })
  assert.deepEqual(JSON.parse(storage.dump()[STORAGE_KEY]), { ...raw, collapsed: false })
})

test('malformed settings safely fall back to defaults', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: '{bad json' })
  assert.deepEqual(loadSettings(storage), { gains: {}, position: null, collapsed: false })
})

test('Google stable id keys fall back to old name key for compatibility', () => {
  const participant = { platform: 'google-meet', participantId: 'abc', name: ' Alice  Smith ' }
  assert.deepEqual(participantStorageKeys(participant), [
    'google-meet:id:abc',
    'google-meet:name:alice smith'
  ])
})

test('saveSettings returns false instead of breaking controls when storage throws', () => {
  assert.equal(saveSettings({ setItem() { throw new Error('quota') } }, { gains: {}, position: null }), false)
})

test('collapsed preference roundtrips booleans and fresh state loads settings once', () => {
  const storage = memoryStorage()
  for (const collapsed of [true, false]) {
    const settings = { gains: { 'google-meet:name:alice': 0 }, position: { left: 9, top: 8 }, collapsed }
    assert.equal(saveSettings(storage, settings), true)
    let reads = 0
    const state = createState({ getItem(key) { reads++; return storage.getItem(key) } })
    assert.equal(reads, 1)
    assert.deepEqual(state.settings, settings)
    assert.equal(state.panelCollapsed, collapsed)
    setParticipantGain(state.settings, { platform: 'google-meet', participantId: 'p1' }, 2.5)
    state.settings.position = { left: 30, top: 40 }
    saveSettings(storage, state.settings)
    assert.equal(loadSettings(storage).collapsed, collapsed)
    assert.equal(createState(storage).panelCollapsed, collapsed)
    assert.deepEqual(Object.keys(storage.dump()), [STORAGE_KEY])
  }
})

test('missing and malformed collapsed preferences default false without losing settings', () => {
  for (const collapsed of [undefined, null, 'true', 'false', 0, 1, [], {}, '']) {
    const raw = { gains: { 'jitsi:id:p1': 0 }, position: { left: 1, top: 2 }, collapsed }
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(raw) })
    const expected = { ...raw, collapsed: false }
    assert.deepEqual(loadSettings(storage), expected)
    assert.equal(saveSettings(storage, raw), true)
    assert.deepEqual(JSON.parse(storage.dump()[STORAGE_KEY]), expected)
    assert.equal(createState(storage).panelCollapsed, false)
  }
  assert.equal(createState(null).panelCollapsed, false)
})
