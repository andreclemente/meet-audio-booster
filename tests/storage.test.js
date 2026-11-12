import test from 'node:test'
import assert from 'node:assert/strict'
import { STORAGE_KEY, LEGACY_STORAGE_KEYS } from '../src/shared/constants.js'
import { loadSettings, saveSettings, participantStorageKeys, setParticipantGain, getParticipantGain, watchSettings, getParticipantUnmute, setParticipantUnmute, rememberAudible } from '../src/storage.js'
import { createState } from '../src/state.js'

const AUTO_OFF = { enabled: false, target: 100 }

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
  assert.deepEqual(loadSettings(storage), { ...raw, unmute: {}, collapsed: false, autoBalance: AUTO_OFF })
})

test('migrates older compatible settings without deleting them before save succeeds', () => {
  const raw = { gains: { 'google-meet:name:alice': 4.5 }, position: { left: 1, top: 2 } }
  const storage = memoryStorage({ [LEGACY_STORAGE_KEYS[0]]: JSON.stringify(raw) })
  assert.deepEqual(loadSettings(storage), { ...raw, unmute: {}, collapsed: false, autoBalance: AUTO_OFF })
  assert.deepEqual(JSON.parse(storage.dump()[STORAGE_KEY]), { ...raw, unmute: {}, collapsed: false, autoBalance: AUTO_OFF })
})

test('malformed settings safely fall back to defaults', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: '{bad json' })
  assert.deepEqual(loadSettings(storage), { gains: {}, unmute: {}, position: null, collapsed: false, autoBalance: AUTO_OFF })
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
    const settings = { gains: { 'google-meet:name:alice': 0 }, unmute: { 'google-meet:name:alice': 1.5 }, position: { left: 9, top: 8 }, collapsed, autoBalance: { enabled: collapsed, target: 120 } }
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
    const expected = { ...raw, unmute: {}, collapsed: false, autoBalance: AUTO_OFF }
    assert.deepEqual(loadSettings(storage), expected)
    assert.equal(saveSettings(storage, raw), true)
    assert.deepEqual(JSON.parse(storage.dump()[STORAGE_KEY]), expected)
    assert.equal(createState(storage).panelCollapsed, false)
  }
  assert.equal(createState(null).panelCollapsed, false)
})

test('a volume set for someone is restored when they rejoin with a new participant id', () => {
  const storage = memoryStorage()
  const first = createState(storage)
  const alice = { platform: 'google-meet', participantId: 'join-1', name: 'Alice  Silva' }
  setParticipantGain(first.settings, alice, 1.6)
  saveSettings(storage, first.settings)
  const later = createState(storage)
  const rejoined = { platform: 'google-meet', participantId: 'join-2', name: 'alice silva' }
  assert.equal(getParticipantGain(later.settings, rejoined), 1.6)
  // A later change follows the person to their next join too.
  setParticipantGain(later.settings, { ...rejoined }, 0.5)
  assert.equal(getParticipantGain(later.settings, rejoined), 0.5)
  assert.equal(getParticipantGain(later.settings, { platform: 'google-meet', participantId: 'join-3', name: 'Alice Silva' }), 0.5)
})

test('Auto Balance on/off and target level are remembered; bad values fall back to off at 100%', () => {
  const storage = memoryStorage()
  assert.equal(saveSettings(storage, { gains: {}, position: null, autoBalance: { enabled: true, target: 130 } }), true)
  assert.deepEqual(loadSettings(storage).autoBalance, { enabled: true, target: 130 })
  for (const [autoBalance, expected] of [[undefined, AUTO_OFF], [null, AUTO_OFF], ['on', AUTO_OFF], [[], AUTO_OFF],
    [{ enabled: 'true', target: 130 }, { enabled: false, target: 130 }], [{ enabled: true, target: 135 }, { enabled: true, target: 100 }],
    [{ enabled: true, target: 200 }, { enabled: true, target: 100 }], [{ enabled: true, target: '110' }, { enabled: true, target: 100 }]]) {
    const s = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ gains: {}, autoBalance }) })
    assert.deepEqual(loadSettings(s).autoBalance, expected, JSON.stringify(autoBalance))
  }
})

test('a save from another tab is adopted, so this tab never writes back its older copy', () => {
  const storage = memoryStorage()
  const settings = loadSettings(storage)
  let handler = null, changes = 0
  watchSettings(settings, { storage, listen: (name, h) => { assert.equal(name, 'storage'); handler = h }, onChange: s => { assert.equal(s, settings); changes++ } })
  // Tab B turns Auto on at 120% and sets a volume.
  const other = loadSettings(storage)
  other.autoBalance = { enabled: true, target: 120 }; setParticipantGain(other, { platform: 'google-meet', name: 'Bob' }, 2)
  saveSettings(storage, other)
  handler({ key: 'unrelated' }); assert.equal(changes, 0)
  handler({ key: STORAGE_KEY, storageArea: storage })
  assert.equal(changes, 1)
  // This tab now saves its own change (panel position) without undoing tab B.
  settings.position = { left: 5, top: 6 }; saveSettings(storage, settings)
  const stored = loadSettings(storage)
  assert.deepEqual(stored.autoBalance, { enabled: true, target: 120 })
  assert.equal(getParticipantGain(stored, { platform: 'google-meet', name: 'Bob' }), 2)
  assert.deepEqual(stored.position, { left: 5, top: 6 })
})

test('unmute volume is remembered per person (id and name), only audible values; default 100%', () => {
  const storage = memoryStorage()
  const settings = loadSettings(storage)
  const alice = { platform: 'google-meet', participantId: 'p1', name: 'Alice' }
  assert.equal(getParticipantUnmute(settings, alice), 1)
  setParticipantUnmute(settings, alice, 1.4)
  setParticipantUnmute(settings, alice, 0)
  saveSettings(storage, settings)
  // Rejoin: new id, same name.
  assert.equal(getParticipantUnmute(loadSettings(storage), { platform: 'google-meet', participantId: 'p9', name: 'alice' }), 1.4)
  const bad = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ gains: {}, unmute: { a: 0, b: -1, c: 7, d: '2', e: 2 } }) })
  assert.deepEqual(loadSettings(bad).unmute, { e: 2 })
  assert.deepEqual(loadSettings(memoryStorage({ [STORAGE_KEY]: JSON.stringify({ gains: {}, unmute: [1] }) })).unmute, {})
})

test('unmute returns to the settled volume: mute button, drag to 0%, Auto values and loaded volumes', () => {
  // Loaded at 150%, muted with the button.
  const a = { value: 1.5 }
  rememberAudible(a, 0); a.value = 0
  assert.equal(a.unmuteValue, 1.5)
  // Drag 90% -> 0% through intermediate values, release at 0%.
  const b = { value: 0.9 }
  for (const v of [0.6, 0.3, 0.05, 0]) { rememberAudible(b, v, { dragging: true }); b.value = v }
  rememberAudible(b, 0); b.value = 0
  assert.equal(b.unmuteValue, 0.9)
  // A released drag to 120% becomes the new unmute volume.
  const c = { value: 1 }
  for (const v of [1.1, 1.2]) { rememberAudible(c, v, { dragging: true }); c.value = v }
  rememberAudible(c, 1.2); c.value = 1.2
  assert.equal(c.unmuteValue, 1.2)
  // Auto Balance values are audible volumes too.
  rememberAudible(c, 1.05); c.value = 1.05
  rememberAudible(c, 0); c.value = 0
  assert.equal(c.unmuteValue, 1.05)
  // Muted from a previous meeting: nothing known here.
  const d = { value: 0 }
  assert.equal(rememberAudible(d, 0), undefined)
})
