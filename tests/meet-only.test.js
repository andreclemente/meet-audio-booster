import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { detectPlatform } from '../src/platforms/google-meet/platform.js'
import { loadSettings } from '../src/storage.js'

for (const hostname of ['meet.jit.si', 'example.com', 'meet.google.com.evil.test', 'localhost', undefined]) {
  test(`unsupported host ${hostname} has no activation or side effects`, () => {
    assert.equal(detectPlatform({ hostname }), null)
    const context = vm.createContext({ location: { hostname } })
    vm.runInContext(readFileSync(new URL('../audio-booster.js', import.meta.url), 'utf8'), context)
    assert.deepEqual(Object.keys(context), ['location'])
  })
}
test('Meet remains the only supported platform and permission', () => {
  assert.equal(detectPlatform({ hostname: 'meet.google.com' }), 'google-meet')
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)))
  assert.deepEqual(manifest.host_permissions, ['https://meet.google.com/*'])
  assert.deepEqual(manifest.content_scripts[0].matches, manifest.host_permissions)
  assert.deepEqual(manifest.permissions, ['scripting'])
})
test('toolbar ignores unsupported tabs without injecting code', async () => {
  let callback
  const calls = []
  vm.runInNewContext(readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8'), {
    URL,
    chrome: { action: { onClicked: { addListener(fn) { callback = fn } } }, scripting: { async executeScript(options) { calls.push(options) } } }
  })
  for (const url of [undefined, 'https://meet.jit.si/room', 'https://example.com', 'https://meet.google.com.evil.test/', 'http://meet.google.com/', 'not a url']) await callback({ id: 4, url })
  assert.equal(calls.length, 0)
  await callback({ id: 4, url: 'https://meet.google.com/abc-defg-hij' })
  assert.equal(calls.length, 1)
})

test('invalid stored coordinates never become panel positions', () => {
  for (const position of [{}, { left: '10', top: 10 }, { left: null, top: 0 }, { left: 4 }, { left: 1e309, top: 20 }]) {
    const settings = loadSettings({ getItem: () => JSON.stringify({ position, gains: { kept: 2 }, collapsed: true }) })
    assert.equal(settings.position, null)
    assert.deepEqual(settings.gains, { kept: 2 })
    assert.equal(settings.collapsed, true)
  }
})
