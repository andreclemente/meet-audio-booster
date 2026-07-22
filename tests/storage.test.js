import test from 'node:test'
import assert from 'node:assert/strict'
import { STORAGE_KEY, LEGACY_STORAGE_KEYS } from '../src/shared/constants.js'
import { loadSettings, saveSettings, participantStorageKeys } from '../src/storage.js'

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
  assert.deepEqual(loadSettings(storage), raw)
})

test('migrates older compatible settings without deleting them before save succeeds', () => {
  const raw = { gains: { 'google-meet:name:alice': 4.5 }, position: { left: 1, top: 2 } }
  const storage = memoryStorage({ [LEGACY_STORAGE_KEYS[0]]: JSON.stringify(raw) })
  assert.deepEqual(loadSettings(storage), raw)
  assert.deepEqual(JSON.parse(storage.dump()[STORAGE_KEY]), raw)
})

test('malformed settings safely fall back to defaults', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: '{bad json' })
  assert.deepEqual(loadSettings(storage), { gains: {}, position: null })
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
