import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

test('production entry does not import the legacy root bundle', async () => {
  const source = await readFile(path.join(root, 'src/main.js'), 'utf8')
  assert.doesNotMatch(source, /(?:from\s*|import\s*)['"]\.\.\/audio-booster\.js['"]/)
  for (const modulePath of ['./storage.js', './ui/panel.js', './platforms/google-meet/index.js', './platforms/jitsi/index.js']) {
    assert.match(source, new RegExp(modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('generated root and dist bundles are identical modular boot artifacts', async () => {
  const [rootBundle, distBundle] = await Promise.all([
    readFile(path.join(root, 'audio-booster.js'), 'utf8'),
    readFile(path.join(root, 'dist/audio-booster.js'), 'utf8')
  ])
  assert.equal(rootBundle, distBundle)
  assert.match(distBundle, /modular-v1/)
  assert.match(distBundle, /__meetingAudioBoosterShow/)
  assert.match(distBundle, /createGoogleMeetController/)
  assert.match(distBundle, /createJitsiController/)
  assert.doesNotMatch(distBundle, /compatibility source/)
})

test('production source modules stay reviewable in size', async () => {
  async function walk(directory) {
    const output = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name)
      if (entry.isDirectory()) output.push(...await walk(item))
      else if (entry.name.endsWith('.js')) output.push(item)
    }
    return output
  }
  for (const file of await walk(path.join(root, 'src'))) {
    const lines = (await readFile(file, 'utf8')).split('\n').length
    assert.ok(lines <= 400, `${path.relative(root, file)} has ${lines} lines`)
  }
})
